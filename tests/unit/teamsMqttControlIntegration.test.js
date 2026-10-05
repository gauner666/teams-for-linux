'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(require.resolve('../../app/index.js'), 'utf8');
function mqttBlock(text) {
	const start = text.indexOf('function handleShortcutCommand(');
	const end = text.indexOf('// Content-based hash', start);
	return text.slice(start, end);
}

function setup(options = {}) {
	const calls = [];
	const events = new EventEmitter();
	const client = new EventEmitter();
	client.initialize = () => calls.push(['initialize']);
	client.publishToTopic = async (...args) => {
		if (options.publishFails) throw new Error('publish failure');
		calls.push(['publish', ...args]);
	};
	const rootContents = { marker: 'root' };
	const rootWindow = { webContents: rootContents, isDestroyed: () => false };
	const control = {
		app: events,
		microphoneControlState: 'unknown',
		MQTTClient: class { constructor() { return client; } },
		MQTTMediaStatusService: class { initialize() { calls.push(['media-initialize']); } },
		HomeAssistantDiscovery: class { initialize() { calls.push(['discovery']); } },
		config: { mqtt: { homeAssistant: { enabled: options.discovery === true } } },
		mainAppWindow: { getWindow: () => rootWindow },
		sendKeyboardEventToWindow: (_window, shortcut) => calls.push(['shortcut', shortcut]),
		profileViewManager: null,
		teamsControlService: new Proxy({}, { get() { throw new Error('MQTT must not access the D-Bus control service'); } }),
		graphApiClient: options.graph === false ? null : {
			getCalendarView: async (...args) => {
				calls.push(['calendar', ...args]);
				if (options.graphFails) throw new Error('graph failure');
				return options.graphResult || { success: true, data: { value: [] } };
			},
		},
		console: { info() {}, warn() {}, error() {} },
		Date,
	};
	vm.createContext(control);
	const start = source.indexOf('function getControlWebContents()');
	const end = source.indexOf('// Content-based hash', start);
	vm.runInContext(source.slice(start, end), control);
	control.initializeMqtt();
	return { control, client, calls, events, rootContents };
}

describe('legacy MQTT parity and independence from D-Bus control', () => {
	it('keeps MQTT handlers independent of the D-Bus services', () => {
		assert.doesNotMatch(mqttBlock(source), /teamsControlService|teamsStateService/);
	});

	it('routes legacy actions to shortcuts, not the independent control service', async () => {
		const { client, calls, events } = setup();
		const command = client.listeners('command')[0];
		events.emit('teams-microphone-control-changed', 'unmuted');
		const actions = ['toggle-mute', 'mute', 'unmute', 'toggle-video', 'toggle-hand-raise', 'leave'];
		for (const action of actions) {
			await command({ action, shortcut: `key:${action}` });
			if (action === 'mute') events.emit('teams-microphone-control-changed', 'muted');
		}
		assert.deepEqual(calls.filter(([kind]) => kind === 'shortcut'), actions.map((action) => ['shortcut', `key:${action}`]));
		assert.equal(calls.some(([kind]) => kind === 'control-service'), false);
		assert.deepEqual(calls.filter(([kind]) => kind === 'initialize' || kind === 'media-initialize'), [['initialize'], ['media-initialize']]);
	});

	it('retains microphone known/unknown, force strictness, and idempotency behavior', async () => {
		const { client, calls, events } = setup();
		const command = client.listeners('command')[0];
		await command({ action: 'mute', shortcut: 'm' });
		assert.equal(calls.some(([kind]) => kind === 'shortcut'), false);
		await command({ action: 'mute', force: 'true', shortcut: 'm' });
		assert.equal(calls.some(([kind]) => kind === 'shortcut'), false);
		await command({ action: 'mute', force: true, shortcut: 'm' });
		assert.equal(calls.filter(([kind]) => kind === 'shortcut').length, 1);
		events.emit('teams-microphone-control-changed', 'muted');
		await command({ action: 'mute', force: true, shortcut: 'm' });
		assert.equal(calls.filter(([kind]) => kind === 'shortcut').length, 1);
		await command({ action: 'unmute', shortcut: 'u' });
		assert.equal(calls.filter(([kind]) => kind === 'shortcut').length, 2);
	});

	it('uses legacy flexible Date.parse validation and publishes the complete calendar envelope', async () => {
		const envelope = { success: true, data: { value: [{ subject: 'meeting' }] }, nextLink: 'full-envelope' };
		const { client, calls } = setup({ graphResult: envelope });
		const command = client.listeners('command')[0];
		for (const dates of [
			['2026-10-05', '2026-10-12'], ['2026-10-05T12:30:00-07:00', '2026-10-12T12:30:00+02:00'], ['October 5, 2026', 'October 12, 2026'],
		]) {
			await command({ action: 'get-calendar', startDate: dates[0], endDate: dates[1] });
		}
		assert.equal(calls.filter(([kind]) => kind === 'calendar').length, 3);
		assert.deepEqual(calls.filter(([kind]) => kind === 'publish'), [
			['publish', 'calendar', envelope], ['publish', 'calendar', envelope], ['publish', 'calendar', envelope],
		]);
	});

	it('does not publish invalid/missing dates, failed Graph results, or missing-client requests', async () => {
		const invalid = setup();
		const handler = invalid.client.listeners('command')[0];
		await handler({ action: 'get-calendar', startDate: 'bad', endDate: 'also bad' });
		await handler({ action: 'get-calendar', startDate: '2026-10-05' });
		assert.equal(invalid.calls.some(([kind]) => kind === 'publish'), false);
		const missingGraph = setup({ graph: false });
		await missingGraph.client.listeners('command')[0]({ action: 'get-calendar', startDate: '2026-10-05', endDate: '2026-10-12' });
		assert.equal(missingGraph.calls.some(([kind]) => kind === 'publish'), false);
		const failedGraph = setup({ graphResult: { success: false, error: 'no' } });
		await failedGraph.client.listeners('command')[0]({ action: 'get-calendar', startDate: '2026-10-05', endDate: '2026-10-12' });
		assert.equal(failedGraph.calls.some(([kind]) => kind === 'publish'), false);
	});

	it('preserves legacy error behavior and HA discovery initialization', async () => {
		const { client, calls } = setup({ discovery: true, publishFails: true });
		assert.equal(calls.some(([kind]) => kind === 'discovery'), true);
		await assert.doesNotReject(client.listeners('command')[0]({ action: 'get-calendar', startDate: '2026-10-05', endDate: '2026-10-12' }));
	});

	it('routes D-Bus webContents selection independently, falling back to the root window', () => {
		const { control, rootContents } = setup();
		control.profileViewManager = { getActiveWebContents: () => ({ isDestroyed: () => true }) };
		assert.equal(control.getControlWebContents(), rootContents);
	});
});
