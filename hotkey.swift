// One global keyboard shortcut that runs a command (justrec shortcut: ⌘⇧6 → justrec shot).
// Uses RegisterEventHotKey, which needs no Accessibility permission.
// Usage: justrec-hotkey <key, e.g. cmd+shift+6> <command> [args...]
import AppKit
import Carbon

let keyCodes: [String: Int] = [
  "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G,
  "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
  "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
  "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
  "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
  "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
]
let modifierFlags: [String: Int] = ["cmd": cmdKey, "shift": shiftKey, "opt": optionKey, "alt": optionKey, "ctrl": controlKey]

let arguments = CommandLine.arguments
guard arguments.count >= 3 else { fputs("usage: justrec-hotkey <cmd+shift+6> <command> [args...]\n", stderr); exit(2) }
var keyCode: Int?
var modifiers = 0
for part in arguments[1].lowercased().split(separator: "+").map(String.init) {
  if let flag = modifierFlags[part] { modifiers |= flag } else { keyCode = keyCodes[part] }
}
guard let code = keyCode, modifiers != 0 else { fputs("Shortcut must be modifiers plus a letter or digit, e.g. cmd+shift+6\n", stderr); exit(2) }

var running: Process?
func fire() {
  if running?.isRunning == true { return } // one shot at a time
  let process = Process()
  process.executableURL = URL(fileURLWithPath: arguments[2])
  process.arguments = Array(arguments.dropFirst(3))
  do { try process.run(); running = process } catch { fputs("Could not run \(arguments[2]): \(error)\n", stderr) }
}

var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in fire(); return noErr }, 1, &eventType, nil, nil)
var reference: EventHotKeyRef?
let status = RegisterEventHotKey(UInt32(code), UInt32(modifiers), EventHotKeyID(signature: OSType(0x4A524543), id: 1), GetApplicationEventTarget(), 0, &reference)
guard status == noErr else { fputs("That shortcut is taken by another app (error \(status)). Pick another with --key.\n", stderr); exit(1) }
print("ready \(arguments[1])"); fflush(stdout)
NSApplication.shared.setActivationPolicy(.prohibited)
NSApplication.shared.run()
