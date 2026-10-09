/** One parsed LWRP line: `VERB positional... KEY:value KEY:"quoted value"`. */
export interface LwrpLine {
	/** The line as received, without trailing CR/LF/spaces */
	raw: string
	/** First token, case preserved ('' if the line starts with an attribute) */
	verb: string
	/** Positional tokens after the verb */
	args: string[]
	/** `KEY:value` pairs, quotes removed. Later duplicates win. */
	attrs: Record<string, string>
}

export type CommandArg = string | number
export type CommandAttrs = Record<string, CommandArg>

const KEY_RE = /([A-Za-z0-9_.]+):/y
const TOKEN_RE = /\S+/y

/** Parse one line from the device. Returns null for empty lines. */
export function parseLine(line: string): LwrpLine | null {
	const raw = line.replace(/[\s\0]+$/, '').replace(/^\s+/, '')
	if (raw === '') return null

	const tokens: string[] = []
	const attrs: Record<string, string> = {}
	let firstIsAttr = false
	let pos = 0
	while (pos < raw.length) {
		if (/\s/.test(raw[pos])) {
			pos++
			continue
		}
		KEY_RE.lastIndex = pos
		// ERROR lines carry free text after the code: never read "word:" in it as an attribute
		const key = tokens[0] === 'ERROR' ? null : KEY_RE.exec(raw)
		if (key) {
			pos = KEY_RE.lastIndex
			if (tokens.length === 0 && Object.keys(attrs).length === 0) firstIsAttr = true
			if (raw[pos] === '"') {
				const end = raw.indexOf('"', pos + 1)
				const stop = end === -1 ? raw.length : end
				attrs[key[1]] = raw.slice(pos + 1, stop)
				pos = Math.min(stop + 1, raw.length)
			} else {
				TOKEN_RE.lastIndex = pos
				const value = TOKEN_RE.exec(raw)
				attrs[key[1]] = value ? value[0] : ''
				pos += value ? value[0].length : 0
			}
		} else {
			TOKEN_RE.lastIndex = pos
			const token = TOKEN_RE.exec(raw)
			if (!token) break
			tokens.push(token[0])
			pos += token[0].length
		}
	}
	const verb = firstIsAttr ? '' : (tokens.shift() ?? '')
	return { raw, verb, args: tokens, attrs }
}

/**
 * Quote a string value for a command. Keeps only printable ASCII and Latin-1 (the wire encoding) and drops `"` and `\`,
 * so the value can never end itself or the line (chars above 0xFF would be truncated to their low byte when written).
 */
export function quote(value: string): string {
	return `"${value.replace(/[^\u0020-\u007e\u00a0-\u00ff]|["\\]/g, '')}"`
}

const SAFE_TOKEN_RE = /^[A-Za-z0-9_.\-/]+$/

function safeToken(token: CommandArg, what: string): string {
	const s = String(token)
	if (typeof token === 'number' && !Number.isFinite(token)) throw new RangeError(`Invalid ${what}: ${s}`)
	if (!SAFE_TOKEN_RE.test(s)) throw new RangeError(`Invalid ${what}: ${JSON.stringify(s)}`)
	return s
}

/**
 * Build a command line (without CRLF). Verb, args and attribute keys must be plain tokens (throws otherwise).
 * Number attribute values are sent bare and must be safe integers; string values are always quoted.
 */
export function formatCommand(verb: string, args: CommandArg[] = [], attrs: CommandAttrs = {}): string {
	const parts = [safeToken(verb, 'verb'), ...args.map((a) => safeToken(a, 'argument'))]
	for (const [key, value] of Object.entries(attrs)) {
		if (!/^[A-Za-z0-9_.]+$/.test(key)) throw new RangeError(`Invalid attribute key: ${JSON.stringify(key)}`)
		if (typeof value === 'number') {
			if (!Number.isSafeInteger(value)) throw new RangeError(`Attribute ${key} must be an integer, got ${value}`)
			parts.push(`${key}:${value}`)
		} else {
			parts.push(`${key}:${quote(value)}`)
		}
	}
	return parts.join(' ')
}

/** `MIX <out> <in>:<tenths> ...`; a null gain clears the crosspoint (`<in>:-`). */
export function mixCommand(output: number, entries: Array<[input: number, tenths: number | null]>): string {
	if (!Number.isSafeInteger(output) || output < 1) throw new RangeError(`Invalid mixer output: ${output}`)
	const parts = ['MIX', String(output)]
	for (const [input, tenths] of entries) {
		if (!Number.isSafeInteger(input) || input < 1) throw new RangeError(`Invalid mixer input: ${input}`)
		if (tenths !== null && !Number.isSafeInteger(tenths))
			throw new RangeError(`Gain must be integer tenths, got ${tenths}`)
		parts.push(`${input}:${tenths ?? '-'}`)
	}
	return parts.join(' ')
}
