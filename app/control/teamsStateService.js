'use strict';

const { app, ipcMain } = require('electron');
const { EventEmitter } = require('node:events');

const PRESENCE = new Map([
	[-1, 'unknown'], [1, 'available'], [2, 'busy'], [3, 'do_not_disturb'], [4, 'away'], [5, 'be_right_back'],
]);
const MICROPHONE_STATES = new Set(['speaking', 'silent', 'muted', 'off', 'unknown']);

/** Main-process, transport-independent snapshot of the Teams state we observe. */
class TeamsStateService extends EventEmitter {
	constructor(config = {}, { appEmitter = app, ipcEmitter = ipcMain, getActiveWebContents = null } = {}) {
		super();
		this.app = appEmitter;
		this.ipc = ipcEmitter;
		this.getActiveWebContents = getActiveWebContents;
		this.microphoneByContents = new WeakMap();
		this.callerEnabled = config.mqtt?.incomingCallCaller?.enabled === true;
		this.resetMs = this.#resetDelay(config.mqtt?.meetingStartDetection?.resetSeconds);
		this.state = {
			presenceStatus: 'unknown', presenceStatusCode: -1, inCall: false, incomingCall: false,
			incomingCallCaller: null, cameraEnabled: false, microphoneState: 'unknown',
			microphoneControlState: 'unknown', screenSharing: false, meetingStarted: false,
		};
		this.meetingTimer = null;
		this.initialized = false;
		this.listeners = [];
	}

	#resetDelay(seconds) {
		const value = Number(seconds ?? 10);
		return Number.isFinite(value) && value >= 0 ? Math.min(value * 1000, 2_147_000_000) : 10_000;
	}

	getState() {
		const snapshot = JSON.parse(JSON.stringify(this.state));
		try {
			const active = this.getActiveWebContents?.();
			if (active) Object.assign(snapshot, this.microphoneByContents.get(active) || {
				microphoneState: 'unknown', microphoneControlState: 'unknown',
			});
		} catch { /* Active profile may not exist during startup/shutdown. */ }
		return snapshot;
	}

	#update(changes) {
		let changed = false;
		for (const [key, value] of Object.entries(changes)) {
			if (JSON.stringify(this.state[key]) !== JSON.stringify(value)) {
				this.state[key] = value;
				changed = true;
			}
		}
		if (changed) this.emit('state-changed', this.getState());
		return changed;
	}

	setPresence(statusCode) {
		if (!Number.isInteger(statusCode) || statusCode < -2_147_483_648 || statusCode > 2_147_483_647) return false;
		this.#update({ presenceStatusCode: statusCode, presenceStatus: PRESENCE.get(statusCode) || 'unknown' });
		return true;
	}

	initialize() {
		if (this.initialized) return;
		this.initialized = true;
		const on = (emitter, event, handler) => {
			emitter.on(event, handler);
			this.listeners.push([emitter, event, handler]);
		};
		on(this.ipc, 'camera-state-changed', (_event, enabled) => {
			if (typeof enabled === 'boolean') this.#update({ cameraEnabled: enabled });
		});
		on(this.ipc, 'microphone-state-changed', (event, state) => {
			if (!MICROPHONE_STATES.has(state)) return;
			const previous = this.getState();
			let active = null;
			try { active = this.getActiveWebContents?.() || null; } catch { /* Startup/shutdown. */ }
			if (event?.sender && typeof event.sender === 'object') {
				const control = state === 'muted' ? 'muted'
					: state === 'speaking' || state === 'silent' ? 'unmuted'
						: state === 'off' ? 'off' : 'unknown';
				this.microphoneByContents.set(event.sender, { microphoneState: state, microphoneControlState: control });
				if (active && active !== event.sender) return;
			}
			this.#setMicrophone(state, previous);
		});
		on(this.ipc, 'screen-sharing-started', () => this.#update({ screenSharing: true }));
		on(this.ipc, 'screen-sharing-stopped', () => this.#update({ screenSharing: false }));
		on(this.ipc, 'meeting-started', () => this.#startMeetingPulse());
		on(this.app, 'teams-call-connected', () => {
			this.#update({ inCall: true });
			this.#clearMeetingPulse();
		});
		on(this.app, 'teams-call-disconnected', (sender) => {
			this.#update({ inCall: false });
			const previousMicrophone = this.getState();
			try {
				const active = this.getActiveWebContents?.();
				const target = sender && typeof sender === 'object' ? sender : active;
				if (target) this.microphoneByContents.set(target, { microphoneState: 'off', microphoneControlState: 'off' });
				// A background account ending its call must not invalidate the active
				// account's microphone observation (and consequently its mute guard).
				if (active && target && target !== active) return;
			} catch { /* Main window may already be shutting down. */ }
			this.#setMicrophone('off', previousMicrophone);
		});
		on(this.app, 'teams-incoming-call-started', (details) => {
			this.#update({ incomingCall: true, incomingCallCaller: this.callerEnabled ? this.#sanitizeCaller(details) : null });
		});
		on(this.app, 'teams-incoming-call-ended', () => this.#update({ incomingCall: false, incomingCallCaller: null }));
	}

	#sanitizeCaller(details) {
		if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
		const caller = {};
		for (const key of ['scenario', 'number', 'name', 'queue', 'contact', 'callId']) {
			const value = details[key];
			if (value !== undefined && value !== null && ['string', 'number', 'boolean'].includes(typeof value)) caller[key] = value;
		}
		return Object.keys(caller).length ? caller : null;
	}

	#setMicrophone(state, previous = this.getState()) {
		if (!MICROPHONE_STATES.has(state)) return;
		const control = state === 'muted' ? 'muted'
			: state === 'speaking' || state === 'silent' ? 'unmuted'
				: state === 'off' ? 'off' : 'unknown';
		const changed = this.#update({ microphoneState: state, microphoneControlState: control });
		const current = this.getState();
		if (!changed && (previous.microphoneState !== current.microphoneState
			|| previous.microphoneControlState !== current.microphoneControlState)) {
			this.emit('state-changed', current);
		}
		if (previous.microphoneControlState !== current.microphoneControlState) {
			// This state service must not drive MQTT's legacy app-level channel.
			// MQTTMediaStatusService remains its sole producer, with its original
			// publish/deduplication timing and command-guard semantics intact.
			this.emit('microphone-control-changed', current.microphoneControlState);
		}
	}

	#startMeetingPulse() {
		if (this.meetingTimer) clearTimeout(this.meetingTimer);
		this.#update({ meetingStarted: true });
		this.meetingTimer = setTimeout(() => {
			this.meetingTimer = null;
			this.#update({ meetingStarted: false });
		}, this.resetMs);
		this.meetingTimer.unref?.();
	}

	#clearMeetingPulse() {
		if (!this.meetingTimer) return;
		clearTimeout(this.meetingTimer);
		this.meetingTimer = null;
		this.#update({ meetingStarted: false });
	}

	dispose() {
		for (const [emitter, event, handler] of this.listeners) emitter.removeListener(event, handler);
		this.listeners = [];
		this.initialized = false;
		if (this.meetingTimer) clearTimeout(this.meetingTimer);
		this.meetingTimer = null;
	}
}

module.exports = TeamsStateService;
