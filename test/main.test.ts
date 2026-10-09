import { describe, expect, it } from 'vitest'
import { SerialQueue } from '../src/main.js'

const sleep = async (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('SerialQueue (lifecycle serialisation)', () => {
	it('never overlaps tasks and keeps submission order', async () => {
		const q = new SerialQueue()
		const log: string[] = []
		let running = 0
		const task = (name: string, ms: number) => async (): Promise<void> => {
			running++
			expect(running).toBe(1)
			log.push(`start ${name}`)
			await sleep(ms)
			log.push(`end ${name}`)
			running--
		}
		await Promise.all([q.run(task('a', 30)), q.run(task('b', 5)), q.run(task('c', 1))])
		expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
	})

	it('a failing task rejects its caller but does not block the next one', async () => {
		const q = new SerialQueue()
		const failing = q.run(async () => Promise.reject(new Error('boom')))
		const next = q.run(async () => Promise.resolve(42))
		await expect(failing).rejects.toThrow('boom')
		await expect(next).resolves.toBe(42)
	})
})
