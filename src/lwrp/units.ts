/** Gains on the wire are integer tenths of a dB. */

export const GAIN_MIN_TENTHS = -1000
export const GAIN_MAX_TENTHS = 240
/** A crosspoint is "on" when its gain is strictly above this. */
export const XPOINT_OFF_TENTHS = -1000
/** Maximum number of active crosspoints per device. */
export const XPOINT_BUDGET = 220

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

/** dB to integer tenths (rounded). Throws on NaN/Infinity so nothing non-integer can reach the wire. */
export function dbToTenths(db: number): number {
	if (!Number.isFinite(db)) throw new RangeError(`Invalid gain: ${db}`)
	const t = Math.round(db * 10)
	return t === 0 ? 0 : t // avoid -0
}

export function tenthsToDb(tenths: number): number {
	return tenths / 10
}

/** Clamp tenths to the SRC INGN / DST OUGN range. */
export function clampGain(tenths: number): number {
	return clamp(Math.round(tenths), GAIN_MIN_TENTHS, GAIN_MAX_TENTHS)
}

export function isXpointOn(tenths: number | undefined): boolean {
	return tenths !== undefined && tenths > XPOINT_OFF_TENTHS
}

/** Tenths to a one-decimal string with an explicit "+" for positive values: -60 -> "-6.0", 35 -> "+3.5", 0 -> "0.0". */
export function formatDb(tenths: number): string {
	const abs = Math.abs(Math.round(tenths))
	const text = `${Math.floor(abs / 10)}.${abs % 10}`
	if (abs === 0) return text
	return tenths < 0 ? `-${text}` : `+${text}`
}
