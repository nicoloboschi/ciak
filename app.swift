// ciak.app: the menu bar app (ciak install), kept small on purpose. macOS ties Screen Recording and
// Microphone permission to this exact build, and programs it starts use its permission. So every feature
// lives in what it starts (ciak-picker for screenshots, the recording panel and recorder via the ciak
// command) and those can change freely; changing this file makes the user grant the permission again.
// It has: the menu, global keys (RegisterEventHotKey, no Accessibility permission), the permission check.
// Settings (defaults com.ciak.app, written by install): keys, picker, cli, recordings. keys is JSON, so new
// shortcuts need no change here: [{"key": "cmd+1", "title": "Take Screenshot", "args": [], "stop": "…"}], each
// starts the picker with its args; pressed again while that picker runs, it gets SIGUSR1 (e.g. stop recording).
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

let settings = UserDefaults.standard
struct Shortcut: Decodable { let key: String; let title: String; let args: [String]; let stop: String?; var code = 0; var modifiers = 0
  enum CodingKeys: String, CodingKey { case key, title, args, stop } }
var shortcuts = (settings.string(forKey: "keys")?.data(using: .utf8)).flatMap { try? JSONDecoder().decode([Shortcut].self, from: $0) }
  ?? [Shortcut(key: settings.string(forKey: "key") ?? "cmd+1", title: "Take Screenshot", args: [], stop: nil)]
for index in shortcuts.indices {
  var keyCode: Int?
  for part in shortcuts[index].key.lowercased().split(separator: "+").map(String.init) {
    if let flag = modifierFlags[part] { shortcuts[index].modifiers |= flag } else { keyCode = keyCodes[part] }
  }
  guard let keyCode, shortcuts[index].modifiers != 0 else { fputs("Shortcut must be modifiers plus a letter or digit, e.g. cmd+1\n", stderr); exit(2) }
  shortcuts[index].code = keyCode
}
let home = FileManager.default.homeDirectoryForCurrentUser
let recordingsDir = URL(fileURLWithPath: settings.string(forKey: "recordings") ?? home.appendingPathComponent("Documents/ciak").path)

func tell(_ title: String, _ text: String, button: String = "OK") -> Bool {
  NSApp.activate(ignoringOtherApps: true)
  let alert = NSAlert()
  alert.messageText = title
  alert.informativeText = text
  alert.addButton(withTitle: button)
  if button != "OK" { alert.addButton(withTitle: "Later") }
  return alert.runModal() == .alertFirstButtonReturn
}

// Without Screen Recording, captures come out as the bare wallpaper. macOS applies a new grant only to a
// fresh process, so: say so, show the setting, and restart once the user allowed it (launchd starts us again).
func permitted() -> Bool {
  if CGPreflightScreenCaptureAccess() { return true }
  CGRequestScreenCaptureAccess()
  NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
  if tell("ciak needs Screen Recording", "Turn on ciak in System Settings › Privacy & Security › Screen Recording, then restart ciak.\n\nAlready on? It belongs to an older ciak: select it, remove it with −, and add it again (or run: tccutil reset ScreenCapture com.ciak.app).", button: "Restart ciak") {
    let restart = Process()
    restart.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    restart.arguments = ["kickstart", "-k", "gui/\(getuid())/com.ciak.app"]
    try? restart.run()
  }
  return false
}

// Starts a helper as this app's child, so it runs with this app's permission. One copy at a time (per arguments).
var helpers: [String: Process] = [:]
func running(_ path: String, _ arguments: [String] = []) -> Process? { helpers[([path] + arguments).joined(separator: " ")].flatMap { $0.isRunning ? $0 : nil } }
func start(_ path: String, _ arguments: [String] = [], output: Pipe? = nil) -> Process? {
  if running(path, arguments) != nil { return nil }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: path)
  process.arguments = arguments
  if let output { process.standardOutput = output }
  do { try process.run() } catch { _ = tell("Cannot start \(URL(fileURLWithPath: path).lastPathComponent)", error.localizedDescription); return nil }
  helpers[([path] + arguments).joined(separator: " ")] = process
  return process
}

func press(_ index: Int) {
  guard shortcuts.indices.contains(index), let picker = settings.string(forKey: "picker") else { return }
  if let helper = running(picker, shortcuts[index].args) { kill(helper.processIdentifier, SIGUSR1); return }
  guard permitted() else { return }
  _ = start(picker, shortcuts[index].args)
}

// The menu bar icon: screenshot, and Record… which opens the recording panel (ciak ui, one copy at a time).
final class Menu: NSObject, NSMenuDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  var panelURL: URL?

  override init() {
    super.init()
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    item.button?.image = NSImage(systemSymbolName: "movieclapper", accessibilityDescription: "ciak")
  }
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let picker = settings.string(forKey: "picker") ?? ""
    let keys: [NSMenuItem] = shortcuts.enumerated().map { index, shortcut in
      let item = NSMenuItem(title: running(picker, shortcut.args) != nil ? shortcut.stop ?? shortcut.title : shortcut.title, action: #selector(shortcutItem), keyEquivalent: keyCodes.first { $0.value == shortcut.code }?.key ?? "")
      let modifiers = shortcut.modifiers
      item.keyEquivalentModifierMask = NSEvent.ModifierFlags(rawValue: (modifiers & cmdKey != 0 ? NSEvent.ModifierFlags.command.rawValue : 0)
        | (modifiers & shiftKey != 0 ? NSEvent.ModifierFlags.shift.rawValue : 0) | (modifiers & optionKey != 0 ? NSEvent.ModifierFlags.option.rawValue : 0)
        | (modifiers & controlKey != 0 ? NSEvent.ModifierFlags.control.rawValue : 0))
      item.tag = index
      return item
    }
    for entry in keys + [NSMenuItem(title: "Record…", action: #selector(panel), keyEquivalent: ""), .separator(),
                  NSMenuItem(title: "Open Recordings", action: #selector(folder), keyEquivalent: ""), .separator(),
                  NSMenuItem(title: "Quit ciak", action: #selector(quit), keyEquivalent: "q")] {
      entry.target = self
      menu.addItem(entry)
    }
  }
  @objc func shortcutItem(_ item: NSMenuItem) { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { press(item.tag) } } // after the menu closes
  @objc func folder() { NSWorkspace.shared.open(recordingsDir) }
  @objc func quit() { helpers.values.forEach { $0.terminate() }; NSApp.terminate(nil) }
  // The panel records as a child of this app, so it uses this app's Screen Recording permission.
  @objc func panel() {
    guard permitted(), let cli = settings.string(forKey: "cli") else { return }
    let output = Pipe()
    // ui opens the page itself and prints {"url": …} first; when it already runs, open its page again.
    guard start(cli, ["ui"], output: output) != nil else { if let panelURL { NSWorkspace.shared.open(panelURL) }; return }
    output.fileHandleForReading.readabilityHandler = { handle in
      if let json = try? JSONSerialization.jsonObject(with: handle.availableData) as? [String: Any], let url = json["url"] as? String {
        handle.readabilityHandler = nil
        DispatchQueue.main.async { self.panelURL = URL(string: url) }
      }
    }
  }
}

// Opened again from Finder or Spotlight while running: one menu bar icon is enough.
if NSRunningApplication.runningApplications(withBundleIdentifier: "com.ciak.app").contains(where: { $0.processIdentifier != getpid() }) { exit(0) }
NSApplication.shared.setActivationPolicy(.accessory)
let menu = Menu()
signal(SIGUSR1, SIG_IGN) // kill -USR1 <pid> presses a shortcut (for testing): the first, or defaults key "press" (its index)
let usr1 = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
usr1.setEventHandler { press(CFPreferencesCopyAppValue("press" as CFString, "com.ciak.app" as CFString) as? Int ?? 0) }
usr1.resume()
signal(SIGUSR2, SIG_IGN) // kill -USR2 <pid> = Record… from the menu (for testing)
let usr2 = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
usr2.setEventHandler { menu.panel() }
usr2.resume()
var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
  var id = EventHotKeyID()
  GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
  DispatchQueue.main.async { press(Int(id.id)) }
  return noErr
}, 1, &eventType, nil, nil)
var references: [EventHotKeyRef?] = []
for (index, shortcut) in shortcuts.enumerated() {
  var reference: EventHotKeyRef?
  let status = RegisterEventHotKey(UInt32(shortcut.code), UInt32(shortcut.modifiers), EventHotKeyID(signature: OSType(0x4A524543), id: UInt32(index)), GetApplicationEventTarget(), 0, &reference)
  if status != noErr { fputs("The shortcut \(shortcut.key) is taken by another app (error \(status)): \(shortcut.title) only from the menu. Pick another with ciak install --key.\n", stderr) }
  references.append(reference)
}
print("ready \(shortcuts.map(\.key).joined(separator: " "))"); fflush(stdout)
NSApplication.shared.run()
