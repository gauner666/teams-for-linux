'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(require.resolve('../../app/index.js'), 'utf8');
const start = source.indexOf('function getControlWebContents()');
const end = source.indexOf('// Content-based hash', start);
assert.notEqual(start, -1, 'getControlWebContents declaration exists');
assert.notEqual(end, -1, 'initializeMqtt declaration end marker exists');
const declarations = source.slice(start, end);

function setup() {
	const calls = [];
	const warnings = [];
	const client = new EventEmitter();
	client.initializeCount = 0;
	client.initialize = () => { client.initializeCount += 1; };
	client.publishToTopic = async (...args) => { calls.push(['publishToTopic', ...args]); };
	const mqttMediaStatusService = { initializeCount: 0, initialize() { this.initializeCount += 1; } };
	const teamsControlService = Object.fromEntries([
		'toggleMute', 'mute', 'unmute', 'toggleVideo', 'toggleHandRaise', 'leaveCall', 'getCalendar',
	].map((method) => [method, async (...args) => {
		calls.push([method, ...args]);
		if (method === 'getCalendar') return calendarResult;
		return true;
	}]));
	let calendarResult = { success: true, data: { value: [{ subject: 'private' }] }, nextLink: 'full-envelope' };
	const control = {
		MQTTClient: class { constructor() { return client; } },
		MQTTMediaStatusService: class { constructor() { return mqttMediaStatusService; } },
		HomeAssistantDiscovery: class { initialize() { throw Error('disabled discovery should not initialize'); } },
		config: { mqtt: { homeAssistant: { enabled: false } } },
		teamsControlService,
		profileViewManager: { getActiveWebContents: () => null },
		mainAppWindow: { getWindow: () => null },
		console: { info() {}, warn: (...args) => warnings.push(args), error() {} },
	};
	vm.createContext(control);
	vm.runInContext(declarations, control);
	control.initializeMqtt();
	return { control, client, calls, warnings, setCalendarResult: (value) => { calendarResult = value; } };
}

describe('MQTT-to-control integration declarations', () => {
	it('maps all MQTT commands to the shared control service, preserving strict force booleans', async () => {
		const { client, calls } = setup();
		const handler = client.listeners('command')[0];
		for (const command of [
			{ action: 'toggle-mute' }, { action: 'mute', force: true }, { action: 'unmute', force: 'true' },
			{ action: 'toggle-video' }, { action: 'toggle-hand-raise' }, { action: 'leave' },
		]) await handler(command);
		assert.deepEqual(calls, [
			['toggleMute'], ['mute', true], ['unmute', false], ['toggleVideo'], ['toggleHandRaise'], ['leaveCall'],
		]);
		assert.equal(client.initializeCount, 1);
	});

	it('publishes the complete successful Graph calendar envelope and does not publish failures', async () => {
		const { client, calls, warnings, setCalendarResult } = setup();
		const handler = client.listeners('command')[0];
		const dates = { action: 'get-calendar', startDate: '2026-10-05', endDate: '2026-10-12' };
		const fullEnvelope = { success: true, data: { value: [{ subject: 'private' }] }, nextLink: 'full-envelope' };
		setCalendarResult(fullEnvelope);
		await handler(dates);
		assert.deepEqual(calls, [
			['getCalendar', '2026-10-05', '2026-10-12'], ['publishToTopic', 'calendar', fullEnvelope],
		]);
		calls.length = 0;
		setCalendarResult({ success: false, error: 'private Graph detail' });
		await handler(dates);
		assert.deepEqual(calls, [['getCalendar', '2026-10-05', '2026-10-12']]);
		assert.deepEqual(warnings, [['[MQTT] Calendar request failed']]);
	});

	it('contains broker publish rejection and does not log private error details', async () => {
		const { client, calls, warnings, setCalendarResult } = setup();
		client.publishToTopic = async () => { throw Error('private broker failure'); };
		setCalendarResult({ success: true, data: { subject: 'private appointment' } });
		const handler = client.listeners('command')[0];
		await assert.doesNotReject(handler({ action: 'get-calendar', startDate: '2026-10-05', endDate: '2026-10-12' }));
		assert.deepEqual(calls, [['getCalendar', '2026-10-05', '2026-10-12']]);
		assert.deepEqual(warnings, [['[MQTT] Command failed']]);
		assert.equal(JSON.stringify(warnings).includes('private'), false);
	});

	it('selects active contents, falls back to a live root window, and safely handles dead or throwing lookups', () => {
		const { control } = setup();
		const active = { marker: 'active', isDestroyed: () => false };
		control.profileViewManager.getActiveWebContents = () => active;
		assert.equal(control.getControlWebContents().marker, 'active');
		control.mainAppWindow.getWindow = () => ({ isDestroyed: () => false, webContents: { marker: 'root', isDestroyed: () => false } });
		control.profileViewManager.getActiveWebContents = () => ({ isDestroyed: () => true });
		const rootContents = control.getControlWebContents();
		assert.equal(rootContents.marker, 'root');
		assert.equal(rootContents.focus, undefined);
		control.mainAppWindow.getWindow = () => ({ isDestroyed: () => true, webContents: {} });
		assert.equal(control.getControlWebContents(), null);
		control.profileViewManager.getActiveWebContents = () => { throw Error('gone'); };
		assert.equal(control.getControlWebContents(), null);
	});
});
