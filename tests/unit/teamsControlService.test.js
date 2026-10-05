'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const TeamsControlService = require('../../app/control/teamsControlService');

function fixture(state = {}) {
	const stateService = new EventEmitter();
	const snapshot = { microphoneControlState: 'unknown', ...state };
	stateService.getState = () => ({
		presenceStatus: 'unknown', presenceStatusCode: -1, inCall: false, incomingCall: false,
		incomingCallCaller: null, cameraEnabled: false, microphoneState: 'unknown',
		microphoneControlState: 'unknown', screenSharing: false, meetingStarted: false, ...snapshot,
	});
	const keyEvents = [];
	const contents = { isDestroyed: () => false, sendInputEvent: (event) => keyEvents.push(event) };
	const control = new TeamsControlService({
		getShortcutWebContents: () => contents,
		performIncomingCallAction: () => true,
		stateService,
	});
	return { control, keyEvents, stateService };
}

describe('TeamsControlService transport-neutral controls', () => {
	it('forwards full state snapshots and detaches on dispose', () => {
		const { control, stateService } = fixture();
		let observed;
		control.on('state-changed', (value) => { observed = value; });
		stateService.emit('state-changed', { inCall: true, incomingCall: false });
		assert.deepEqual(Object.keys(observed).sort(), [
			'presenceStatus', 'presenceStatusCode', 'inCall', 'incomingCall', 'incomingCallCaller',
			'cameraEnabled', 'microphoneState', 'microphoneControlState', 'screenSharing', 'meetingStarted',
		].sort());
		assert.equal(observed.inCall, false);
		observed.inCall = true;
		assert.equal(control.getState().inCall, false, 'returned snapshots are detached copies');
		control.dispose();
		stateService.emit('state-changed', { inCall: false });
		assert.equal(observed.inCall, true);
	});

	it('dispatches each shortcut with exact keyDown/keyUp and modifiers', () => {
		for (const [method, keyCode] of [
			['toggleMute', 'M'], ['mute', 'M'], ['unmute', 'M'],
			['toggleVideo', 'O'], ['toggleHandRaise', 'K'], ['leaveCall', 'H'],
		]) {
			const { control, keyEvents } = fixture({ microphoneControlState: method === 'unmute' ? 'muted' : 'unmuted' });
			const result = method === 'mute' ? control.mute()
				: method === 'unmute' ? control.unmute() : control[method]();
			assert.equal(result, true, `${method} dispatches`);
			assert.deepEqual(keyEvents, [
				{ type: 'keyDown', keyCode, modifiers: ['control', 'shift'] },
				{ type: 'keyUp', keyCode, modifiers: ['control', 'shift'] },
			]);
		}
	});

	it('mutes/unmutes only when needed, rejects unknown/off without force, and force always toggles unknown', () => {
		for (const [method, current, force, expected] of [
			['mute', 'muted', false, false], ['mute', 'unmuted', false, true],
			['unmute', 'unmuted', false, false], ['unmute', 'muted', false, true],
			['mute', 'unknown', false, false], ['unmute', 'unknown', false, false],
			['mute', 'off', false, false], ['unmute', 'off', false, false],
			['mute', 'unknown', true, true], ['unmute', 'off', true, true],
		]) {
			const { control, keyEvents } = fixture({ microphoneControlState: current });
			const result = control[method](force);
			assert.equal(result, expected, `${method} from ${current} force=${force}`);
			assert.equal(keyEvents.length, expected ? 2 : 0, 'no-dispatch cases send no key events');
		}
		const { control, keyEvents } = fixture({ microphoneControlState: 'unknown' });
		assert.equal(control.mute('true'), false, 'force accepts booleans only');
		assert.equal(keyEvents.length, 0);
	});

	it('returns date-only and timestamp Graph success envelopes and emits the full result', async () => {
		const { control } = fixture();
		const events = [];
		control.on('calendar-received', (result) => events.push(result));
		const result = { success: true, data: { value: [{ id: 'event-1' }] }, extra: 'preserved' };
		let args;
		control.getGraphApiClient = () => ({ getCalendarView: async (...values) => { args = values; return result; } });
		assert.equal(await control.getCalendar('2026-10-01', '2026-10-02'), result);
		assert.deepEqual(args, ['2026-10-01', '2026-10-02']);
		assert.equal(await control.getCalendar('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'), result);
		assert.deepEqual(events, [result, result]);
	});

	it('emits envelopes for Graph failure, rejection, missing client, malformed result, and invalid dates', async () => {
		const { control } = fixture();
		const valid = ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'];
		const events = [];
		control.on('calendar-received', (result) => events.push(result));
		const missing = await control.getCalendar(...valid);
		assert.deepEqual(missing, { success: false, error: 'Graph API client not initialized' });
		const invalid = await control.getCalendar('2026-02-30', '2026-03-01');
		assert.deepEqual(invalid, { success: false, error: 'Invalid calendar date range' });
		assert.deepEqual(await control.getCalendar(valid[1], valid[0]), { success: false, error: 'Invalid calendar date range' });
		control.getGraphApiClient = () => ({ getCalendarView: async () => ({ success: false, error: 'Graph unavailable' }) });
		const graphFailure = { success: false, error: 'Graph unavailable' };
		assert.deepEqual(await control.getCalendar(...valid), graphFailure);
		control.getGraphApiClient = () => ({ getCalendarView: async () => { throw Error('offline'); } });
		const rejected = { success: false, error: 'offline' };
		assert.deepEqual(await control.getCalendar(...valid), rejected);
		control.getGraphApiClient = () => ({ getCalendarView: async () => null });
		const malformed = { success: false, error: 'Invalid Graph API response' };
		assert.deepEqual(await control.getCalendar(...valid), malformed);
		assert.deepEqual(events, [missing, invalid, { success: false, error: 'Invalid calendar date range' }, graphFailure, rejected, malformed]);
	});
});
