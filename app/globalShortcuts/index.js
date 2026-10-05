/**
 * Global Shortcuts Module
 *
 * Registers system-wide keyboard shortcuts that forward events to Teams.
 * This allows Teams' built-in shortcuts to work even when the app is not focused.
 */

const { globalShortcut } = require("electron");
const os = require("node:os");

const isMac = os.platform() === "darwin";
let isRegistered = false;

/**
 * Parses an Electron accelerator string into key and modifiers.
 *
 * @param {string} accelerator - The accelerator string (e.g., "Control+Shift+M")
 * @returns {Object|null} - Key and modifiers, or null for an invalid accelerator
 */
function parseAccelerator(accelerator) {
  if (typeof accelerator !== "string" || accelerator.length === 0 || accelerator.length > 128) return null;
  if ([...accelerator].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) return null;
  const parts = accelerator.split("+");
  const modifiers = [];
  let key = null;
  const seenModifiers = new Set();
  const punctuationKeys = new Set([",", ".", ";", "'", "`", "-", "/", "=", "[", "]", "\\"]);
  const keyAliases = new Set([
    "Backspace", "Tab", "Enter", "Return", "Escape", "Esc", "Space", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
    "Up", "Down", "Left", "Right", "PrintScreen", "Plus", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24", "VolumeUp", "VolumeDown", "VolumeMute",
    "MediaNextTrack", "MediaPreviousTrack", "MediaStop", "MediaPlayPause", "NumLock", "ScrollLock", "CapsLock", "Clear", "Pause",
    "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9",
    "NumpadDecimal", "NumpadDivide", "NumpadMultiply", "NumpadSubtract", "NumpadAdd", "NumpadEnter", "NumpadEqual",
  ]);

  for (const part of parts) {
    const lower = part.toLowerCase();
    let modifier;
    if (lower === "commandorcontrol" || lower === "cmdorctrl") modifier = isMac ? "cmd" : "control";
    else if (lower === "command" || lower === "cmd") modifier = "cmd";
    else if (lower === "control" || lower === "ctrl") modifier = "control";
    else if (lower === "shift") modifier = "shift";
    else if (lower === "alt" || lower === "option") modifier = "alt";

    if (modifier) {
      if (seenModifiers.has(modifier)) return null;
      seenModifiers.add(modifier);
      modifiers.push(modifier);
    } else {
      if (key !== null) return null;
      if (/^[a-z0-9]$/i.test(part)) key = part.toUpperCase();
      else if (punctuationKeys.has(part)) key = part;
      else if (keyAliases.has(part)) key = part;
      else return null;
    }
  }

  if (key === null) return null;
  return { key, modifiers };
}

/**
 * @param {WebContents} webContents - The Teams renderer to send the event to
 * @param {string} accelerator - The accelerator string (e.g., "Control+Shift+M")
 * @returns {boolean} - Whether both input events were dispatched
 */
function sendKeyboardEventToWebContents(webContents, accelerator) {
  try {
    if (!webContents || webContents.isDestroyed()) return false;
    const parsed = parseAccelerator(accelerator);
    if (!parsed) return false;

    webContents.sendInputEvent({
      type: "keyDown",
      keyCode: parsed.key,
      modifiers: parsed.modifiers
    });

    webContents.sendInputEvent({
      type: "keyUp",
      keyCode: parsed.key,
      modifiers: parsed.modifiers
    });

    return true;
  } catch (err) {
    console.error(`[GLOBAL_SHORTCUTS] Error sending keyboard event: ${err.message}`);
    return false;
  }
}

function sendKeyboardEventToWindow(window, accelerator) {
  try {
    if (!window || window.isDestroyed()) return false;
    return sendKeyboardEventToWebContents(window.webContents, accelerator);
  } catch (err) {
    console.error(`[GLOBAL_SHORTCUTS] Error sending keyboard event: ${err.message}`);
    return false;
  }
}

function register(config, mainAppWindow, app) {
  // Guard against multiple registrations
  if (isRegistered) {
    console.debug("[GLOBAL_SHORTCUTS] Already registered, skipping");
    return;
  }

  if (!Array.isArray(config.globalShortcuts) || config.globalShortcuts.length === 0) {
    console.debug("[GLOBAL_SHORTCUTS] No global shortcuts configured");
    isRegistered = true; // Mark as registered even with no shortcuts to maintain guard integrity
    return;
  }

  let registeredCount = 0;

  for (const shortcut of config.globalShortcuts) {
    // Skip empty or invalid shortcuts
    if (!shortcut || typeof shortcut !== "string") {
      console.debug(`[GLOBAL_SHORTCUTS] Skipping invalid shortcut: ${shortcut}`);
      continue;
    }

    try {
      const registered = globalShortcut.register(shortcut, () => {
        console.debug(`[GLOBAL_SHORTCUTS] Shortcut triggered: ${shortcut}`);

        const window = mainAppWindow.getWindow();
        if (window && !window.isDestroyed()) {
          // Forward the keyboard event to Teams by simulating the key press
          // Teams will handle it with its built-in keyboard shortcuts
          // Note: In practice, sending keyboard events works reliably without focusing the window.
          sendKeyboardEventToWindow(window, shortcut);
        } else {
          console.warn(`[GLOBAL_SHORTCUTS] Main window not available for shortcut: ${shortcut}`);
        }
      });

      if (registered) {
        console.info(`[GLOBAL_SHORTCUTS] Registered: ${shortcut}`);
        registeredCount++;
      } else {
        console.warn(`[GLOBAL_SHORTCUTS] Failed to register ${shortcut} (may already be in use by another application)`);
      }
    } catch (err) {
      console.error(`[GLOBAL_SHORTCUTS] Error registering ${shortcut}: ${err.message}`);
    }
  }

  // Unregister all shortcuts on app quit
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    console.debug("[GLOBAL_SHORTCUTS] Unregistered all shortcuts");
    isRegistered = false;
  });

  if (registeredCount > 0) {
    isRegistered = true;
    console.info(`[GLOBAL_SHORTCUTS] Successfully registered ${registeredCount} global shortcut(s)`);
  }
}

module.exports = { register, sendKeyboardEventToWindow, sendKeyboardEventToWebContents, parseAccelerator };
