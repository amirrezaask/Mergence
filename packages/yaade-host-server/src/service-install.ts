import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

export type UserServiceOptions = {
  executable: string
  dataDir: string
  serviceName?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
}

export type UserServiceStatus = {
  platform: NodeJS.Platform
  installed: boolean
  running: boolean
  path: string
  message: string
}

const DEFAULT_SERVICE_NAME = "com.yaade.server"

function serviceName(options: UserServiceOptions): string {
  return options.serviceName?.trim() || DEFAULT_SERVICE_NAME
}

export function userServicePath(options: UserServiceOptions): string {
  const name = serviceName(options)
  if (process.platform === "linux") {
    return path.join(os.homedir(), ".config", "systemd", "user", `${name}.service`)
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${name}.plist`)
  }
  return path.join(os.homedir(), "AppData", "Local", "YAADE", `${name}.xml`)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function renderUserService(options: UserServiceOptions): string {
  const args = options.args ?? []
  const envEntries = Object.entries(options.env ?? {})
  if (process.platform === "linux") {
    const command = [options.executable, ...args].map(shellQuote).join(" ")
    const environment = envEntries
      .map(([key, value]) => `Environment=${key}=${shellQuote(value)}`)
      .join("\n")
    return `[Unit]\nDescription=YAADE durable agent daemon\nAfter=default.target\n\n[Service]\nExecStart=${command}\nRestart=on-failure\nRestartSec=2\n${environment ? `${environment}\n` : ""}\n[Install]\nWantedBy=default.target\n`
  }
  if (process.platform === "darwin") {
    const programArguments = [options.executable, ...args]
      .map(value => `    <string>${escapeXml(value)}</string>`)
      .join("\n")
    const environment = envEntries.length
      ? `  <key>EnvironmentVariables</key><dict>\n${envEntries
        .map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
        .join("\n")}\n  </dict>\n`
      : ""
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${escapeXml(serviceName(options))}</string>\n  <key>ProgramArguments</key><array>\n${programArguments}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>WorkingDirectory</key><string>${escapeXml(options.dataDir)}</string>\n${environment}</dict></plist>\n`
  }
  const command = [options.executable, ...args].map(value => escapeXml(value)).join(" ")
  return `<Task version="1.4"><RegistrationInfo><Description>YAADE durable agent daemon</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><RestartOnFailure><Interval>PT2M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${escapeXml(options.executable)}</Command><Arguments>${command.slice(options.executable.length).trim()}</Arguments><WorkingDirectory>${escapeXml(options.dataDir)}</WorkingDirectory></Exec></Actions></Task>`
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, character => {
    switch (character) {
      case "<": return "&lt;"
      case ">": return "&gt;"
      case "&": return "&amp;"
      case "'": return "&apos;"
      default: return "&quot;"
    }
  })
}

function run(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { stdio: "ignore", windowsHide: true })
    child.once("error", () => resolve(false))
    child.once("exit", code => resolve(code === 0))
  })
}

export async function installUserService(options: UserServiceOptions): Promise<UserServiceStatus> {
  const target = userServicePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, renderUserService(options), { mode: 0o600 })
  let running = false
  if (process.platform === "linux") {
    await run("systemctl", ["--user", "daemon-reload"])
    running = await run("systemctl", ["--user", "enable", "--now", serviceName(options)])
  } else if (process.platform === "darwin") {
    const uid = String(process.getuid?.() ?? 0)
    await run("launchctl", ["bootout", `gui/${uid}/${serviceName(options)}`])
    running = await run("launchctl", ["bootstrap", `gui/${uid}`, target])
  } else {
    running = await run("schtasks.exe", ["/Create", "/F", "/TN", serviceName(options), "/XML", target])
  }
  return { platform: process.platform, installed: true, running, path: target, message: running ? "service installed and running" : "service installed; start it with the platform service manager" }
}

export async function controlUserService(
  action: "start" | "stop" | "restart",
  options: UserServiceOptions,
): Promise<UserServiceStatus> {
  const name = serviceName(options)
  let running = false
  if (process.platform === "linux") {
    running = await run("systemctl", ["--user", action === "restart" ? "restart" : action, name])
  } else if (process.platform === "darwin") {
    const uid = String(process.getuid?.() ?? 0)
    if (action === "stop") {
      running = await run("launchctl", ["bootout", `gui/${uid}/${name}`])
    } else {
      if (action === "restart") await run("launchctl", ["bootout", `gui/${uid}/${name}`])
      running = await run("launchctl", ["bootstrap", `gui/${uid}`, userServicePath(options)])
    }
  } else {
    running = await run("schtasks.exe", [action === "stop" ? "/End" : "/Run", "/TN", name])
  }
  return {
    platform: process.platform,
    installed: fs.existsSync(userServicePath(options)),
    running,
    path: userServicePath(options),
    message: running ? `service ${action} requested` : `could not ${action} service`,
  }
}

export async function statusUserService(options: UserServiceOptions): Promise<UserServiceStatus> {
  const target = userServicePath(options)
  const name = serviceName(options)
  const installed = fs.existsSync(target)
  let running = false
  if (process.platform === "linux") {
    running = await run("systemctl", ["--user", "is-active", name])
  } else if (process.platform === "darwin") {
    const uid = String(process.getuid?.() ?? 0)
    running = await run("launchctl", ["print", `gui/${uid}/${name}`])
  } else {
    running = await run("schtasks.exe", ["/Query", "/TN", name])
  }
  return {
    platform: process.platform,
    installed,
    running,
    path: target,
    message: !installed
      ? "service is not installed"
      : running
        ? "service is running"
        : "service is installed but not running",
  }
}

export async function uninstallUserService(options: UserServiceOptions): Promise<UserServiceStatus> {
  const target = userServicePath(options)
  if (process.platform === "linux") {
    await run("systemctl", ["--user", "disable", "--now", serviceName(options)])
  } else if (process.platform === "darwin") {
    const uid = String(process.getuid?.() ?? 0)
    await run("launchctl", ["bootout", `gui/${uid}/${serviceName(options)}`])
  } else {
    await run("schtasks.exe", ["/Delete", "/F", "/TN", serviceName(options)])
  }
  try { fs.unlinkSync(target) } catch { /* already absent */ }
  return { platform: process.platform, installed: false, running: false, path: target, message: "service removed" }
}
