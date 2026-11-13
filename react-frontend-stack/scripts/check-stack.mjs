#!/usr/bin/env node
// Read-only health check for the React + Vite+ + shadcn + TanStack stack.
// Usage: node scripts/check-stack.mjs [project-dir]

import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(process.argv[2] ?? process.cwd())
const results = []
let failed = 0
let warned = 0

function pass(label, detail = "") {
  results.push(["PASS", label, detail])
}

function fail(label, detail = "") {
  failed++
  results.push(["FAIL", label, detail])
}

function warn(label, detail = "") {
  warned++
  results.push(["WARN", label, detail])
}

async function exists(file) {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

async function read(file) {
  try {
    return await readFile(file, "utf8")
  } catch {
    return null
  }
}

async function findFirst(names) {
  for (const name of names) {
    const file = path.join(root, name)
    if (await exists(file)) return file
  }
  return null
}

const pkgPath = path.join(root, "package.json")
const pkgRaw = await read(pkgPath)

if (!pkgRaw) {
  console.error(`No package.json found in ${root}`)
  process.exit(1)
}

let pkg
try {
  pkg = JSON.parse(pkgRaw)
} catch {
  console.error(`package.json is not valid JSON: ${pkgPath}`)
  process.exit(1)
}

const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
const has = (name) => Boolean(deps[name])
const version = (name) => deps[name] ?? ""

pass("package.json", pkg.name ? `name: ${pkg.name}` : "")

const required = [
  ["react", "React"],
  ["react-dom", "React DOM"],
  ["vite-plus", "Vite+ toolchain"],
  ["@vitejs/plugin-react", "React Vite plugin"],
  ["tailwindcss", "Tailwind CSS"],
  ["@tailwindcss/vite", "Tailwind Vite plugin"],
  ["@tanstack/react-router", "TanStack Router"],
  ["@tanstack/router-plugin", "TanStack Router plugin"],
  ["@tanstack/react-query", "TanStack Query"],
  ["kubai-icons-react", "Kubai Icons"],
]

for (const [name, label] of required) {
  if (has(name)) pass(label, version(name))
  else fail(label, `missing dependency: ${name}`)
}

for (const banned of ["vite", "vitest", "oxlint", "oxfmt", "eslint", "prettier"]) {
  if (!has(banned)) continue
  if (banned === "vite" && version("vite").includes("vite-plus-core")) {
    pass("vite alias", version("vite"))
    continue
  }
  warn(`${banned} is a direct dependency`, "Vite+ owns this tool; remove it unless the project intentionally migrated")
}

if (!has("lucide-react")) {
  warn("lucide-react not found", "shadcn components import it; run shadcn init/add")
}

const optional = [
  ["@tanstack/react-table", "Table"],
  ["@tanstack/react-form", "Form"],
  ["@tanstack/react-virtual", "Virtual"],
  ["@tanstack/react-store", "Store"],
  ["@tanstack/react-start", "Start"],
  ["@tanstack/react-db", "DB"],
]
const enabled = optional.filter(([name]) => has(name)).map(([, label]) => label)
if (enabled.length) pass("Optional TanStack modules", enabled.join(", "))

if (pkg.scripts?.check) pass("Check script", pkg.scripts.check)
else warn("Check script", 'add "check": "vp check"')

if (pkg.scripts?.doctor) pass("React Doctor script", pkg.scripts.doctor)
else warn("React Doctor script", 'add "doctor": "vp dlx react-doctor@latest --no-telemetry"')

const doctorConfig = await findFirst([
  "doctor.config.ts",
  "doctor.config.mts",
  "doctor.config.js",
  "doctor.config.mjs",
  "doctor.config.json",
  "doctor.config.jsonc",
])
if (doctorConfig) pass("React Doctor config", path.relative(root, doctorConfig))
else warn("React Doctor config", "no doctor.config.*; defaults are okay, add one for rule overrides")

const viteConfigPath = await findFirst([
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
])
const viteConfig = viteConfigPath ? await read(viteConfigPath) : null

if (!viteConfig) {
  fail("Vite config", "no vite.config.ts / .mts / .js / .mjs")
} else {
  pass("Vite config", path.relative(root, viteConfigPath))

  if (/from\s+["']vite-plus["']/.test(viteConfig)) pass("Config imports vite-plus")
  else fail("Config imports vite-plus", "use defineConfig from 'vite-plus'")

  if (/tanstackRouter\s*\(/.test(viteConfig)) pass("TanStack Router plugin")
  else fail("TanStack Router plugin", "add tanstackRouter({ target: 'react' })")

  if (/tailwindcss\s*\(/.test(viteConfig)) pass("Tailwind Vite plugin")
  else fail("Tailwind Vite plugin", "add tailwindcss()")

  if (/alias\s*:\s*\{[\s\S]{0,400}?["']@["']\s*:/.test(viteConfig)) {
    pass("Vite alias '@'")
  } else {
    fail("Vite alias '@'", "add resolve.alias['@'] = src")
  }

  const pluginBlock = viteConfig.match(/plugins\s*:\s*(?:lazyPlugins\s*\(\s*\(\s*\)\s*=>\s*)?\[([\s\S]*?)\]/)
  if (pluginBlock) {
    const block = pluginBlock[1]
    const routerAt = block.search(/tanstackRouter\s*\(/)
    const reactAt = block.search(/react\s*\(\s*\)/)
    if (routerAt !== -1 && reactAt !== -1 && routerAt > reactAt) {
      warn("Plugin order", "tanstackRouter must run before react()")
    } else if (routerAt !== -1 && reactAt !== -1) {
      pass("Plugin order", "tanstackRouter before react")
    }
  }

  if (/typeAware\s*:\s*true/.test(viteConfig) && /typeCheck\s*:\s*true/.test(viteConfig)) {
    pass("Type-aware checks", "typeAware + typeCheck enabled")
  } else {
    warn("Type-aware checks", "set lint.options.typeAware and typeCheck to true")
  }

  if (/routeTree\.gen\.ts/.test(viteConfig)) pass("Generated route tree ignored")
  else warn("Generated route tree ignored", "add src/routeTree.gen.ts to lint/fmt ignorePatterns")
}

const tsconfigCandidates = ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]
let sawPaths = false
let sawBaseUrl = false
for (const name of tsconfigCandidates) {
  const raw = await read(path.join(root, name))
  if (!raw) continue
  if (/"@\/\*"\s*:\s*\[/.test(raw)) sawPaths = true
  if (/"baseUrl"\s*:/.test(raw)) sawBaseUrl = true
}
if (sawPaths) pass("Path alias '@/*'")
else fail("Path alias '@/*'", "add paths to tsconfig.json and tsconfig.app.json")
if (sawBaseUrl) fail("tsconfig baseUrl", "TypeScript 7 removed baseUrl; delete it and keep paths")

const componentsPath = path.join(root, "components.json")
const componentsRaw = await read(componentsPath)
if (!componentsRaw) {
  fail("components.json", "run shadcn init")
} else {
  pass("components.json")
  try {
    const components = JSON.parse(componentsRaw)
    const css = components.tailwind?.css
    if (css && (await exists(path.join(root, css)))) {
      const cssRaw = await read(path.join(root, css))
      if (/@import\s+["']tailwindcss["']/.test(cssRaw ?? "")) pass("Tailwind import", css)
      else fail("Tailwind import", `add @import "tailwindcss" to ${css}`)
    } else {
      fail("Tailwind CSS file", css ? `not found: ${css}` : "tailwind.css is not set")
    }
    if (components.aliases?.ui) pass("shadcn UI alias", components.aliases.ui)
    else fail("shadcn UI alias", "components.json aliases.ui is required")
  } catch {
    fail("components.json", "invalid JSON")
  }
}

const rootRoutePath = path.join(root, "src", "routes", "__root.tsx")
if (await exists(rootRoutePath)) pass("Root route", "src/routes/__root.tsx")
else fail("Root route", "create src/routes/__root.tsx")

const routeTreePath = path.join(root, "src", "routeTree.gen.ts")
if (await exists(routeTreePath)) {
  pass("Generated route tree", "src/routeTree.gen.ts")
} else {
  warn("Generated route tree", "created by the Router plugin on vp dev / vp build")
}

const uiDir = path.join(root, "src", "components", "ui")
try {
  const files = await readdir(uiDir)
  pass("shadcn components", `${files.length} file(s)`)
} catch {
  warn("shadcn components", "src/components/ui is empty or missing")
}

const color = (status) =>
  status === "PASS" ? "\x1b[32m" : status === "WARN" ? "\x1b[33m" : "\x1b[31m"
const reset = "\x1b[0m"

console.log(`\nReact frontend stack check — ${root}\n`)
for (const [status, label, detail] of results) {
  console.log(`${color(status)}${status}${reset}  ${label}${detail ? ` — ${detail}` : ""}`)
}

const passed = results.length - failed - warned
console.log(`\n${passed} passed, ${warned} warning(s), ${failed} failed\n`)
console.log("React Doctor is mandatory: vp dlx react-doctor@latest --no-telemetry\n")

if (failed > 0) process.exit(1)
