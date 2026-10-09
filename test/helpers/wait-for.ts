/** Resolve after `ms` real milliseconds. Prefer `waitFor` over sleeping for a condition. */
export async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WaitForOptions {
	timeoutMs?: number
	intervalMs?: number
	message?: string
}

/** Poll `predicate` until it returns a truthy value (which is returned); throws on timeout. */
export async function waitFor<T>(
	predicate: () => T | Promise<T>,
	{ timeoutMs = 4000, intervalMs = 4, message }: WaitForOptions = {},
): Promise<NonNullable<T>> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = await predicate()
		if (value) return value
		if (Date.now() > deadline)
			throw new Error(`waitFor timed out after ${timeoutMs} ms${message ? `: ${message}` : ''}`)
		await sleep(intervalMs)
	}
}

/** Assert that `predicate` stays falsy for `ms` (negative check, costs `ms`). */
export async function stays(predicate: () => unknown, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (predicate()) return false
		await sleep(4)
	}
	return !predicate()
}
