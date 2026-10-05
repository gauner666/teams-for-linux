const { sendKeyboardEventToWebContents } = require("../globalShortcuts");
const { EventEmitter } = require("node:events");

const SHORTCUTS = {
  mute: "Ctrl+Shift+M",
  video: "Ctrl+Shift+O",
  handRaise: "Ctrl+Shift+K",
  leave: "Ctrl+Shift+H",
};

class TeamsControlService extends EventEmitter {
  constructor({ getShortcutWebContents, performIncomingCallAction, stateService = null, getGraphApiClient = () => null }) {
    super();
    this.getShortcutWebContents = getShortcutWebContents;
    this.performIncomingCallAction = performIncomingCallAction;
    this.stateService = stateService;
    this.getGraphApiClient = getGraphApiClient;
    this.onStateChanged = () => this.emit("state-changed", this.getState());
    this.stateService?.on("state-changed", this.onStateChanged);
  }

  getState() {
    return this.stateService?.getState() ?? {
      presenceStatus: "unknown", presenceStatusCode: -1, inCall: false, incomingCall: false,
      incomingCallCaller: null, cameraEnabled: false, microphoneState: "unknown",
      microphoneControlState: "unknown", screenSharing: false, meetingStarted: false,
    };
  }

  refreshState() {
    const snapshot = this.getState();
    this.emit("state-changed", snapshot);
    return snapshot;
  }

  dispose() {
    this.stateService?.removeListener("state-changed", this.onStateChanged);
  }

  acceptAudio() {
    return this.#callAction("ACCEPT_AUDIO");
  }

  acceptVideo() {
    return this.#callAction("ACCEPT_VIDEO");
  }

  declineCall() {
    return this.#callAction("DECLINE");
  }

  toggleMute() {
    return this.sendShortcut(SHORTCUTS.mute);
  }

  mute(force = false) {
    return this.#setMute("muted", force);
  }

  unmute(force = false) {
    return this.#setMute("unmuted", force);
  }

  #setMute(desired, force) {
    if (typeof force !== "boolean") return false;
    const state = this.getState()?.microphoneControlState ?? "unknown";
    if (state === desired) return false;
    if (state !== "muted" && state !== "unmuted" && !force) return false;
    return this.toggleMute();
  }

  toggleVideo() {
    return this.sendShortcut(SHORTCUTS.video);
  }

  toggleHandRaise() {
    return this.sendShortcut(SHORTCUTS.handRaise);
  }

  leaveCall() {
    return this.sendShortcut(SHORTCUTS.leave);
  }

  async getCalendar(startDate, endDate) {
    const fail = (error) => {
      const envelope = { success: false, error };
      this.emit("calendar-received", envelope);
      return envelope;
    };
    const iso = (value) => {
      if (typeof value !== "string" || value.length > 64) return false;
      const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2})))?$/.exec(value);
      if (!match) return false;
      const [, year, month, day, hour, minute, second, , , offsetHour, offsetMinute] = match;
      const maxDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
      if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > maxDay) return false;
      if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) return false;
      if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
      return Number.isFinite(Date.parse(value));
    };
    if (!iso(startDate) || !iso(endDate) || Date.parse(endDate) < Date.parse(startDate)) {
      return fail("Invalid calendar date range");
    }
    try {
      const client = this.getGraphApiClient?.();
      if (!client || typeof client.getCalendarView !== "function") {
        return fail("Graph API client not initialized");
      }
      const result = await client.getCalendarView(startDate, endDate);
      const envelope = result && typeof result === "object" && typeof result.success === "boolean"
        ? result : { success: false, error: "Invalid Graph API response" };
      this.emit("calendar-received", envelope);
      return envelope;
    } catch (error) {
      return fail(error?.message || "Calendar request failed");
    }
  }

  #callAction(action) {
    try {
      const result = this.performIncomingCallAction(action);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        return false;
      }
      return result === true;
    } catch {
      return false;
    }
  }

  sendShortcut(accelerator) {
    try {
      const webContents = this.getShortcutWebContents();
      if (!webContents || webContents.isDestroyed()) return false;
      return sendKeyboardEventToWebContents(webContents, accelerator);
    } catch {
      return false;
    }
  }
}

module.exports = TeamsControlService;
