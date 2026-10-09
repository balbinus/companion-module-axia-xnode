import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseLine, type LwrpLine } from '../../src/lwrp/parser.js'
import { XNodeState } from '../../src/model/state.js'

export type FixtureName = 'legacy-analog4x4-a' | 'legacy-analog4x4-b' | 'xnode2-combo'

/** Raw fixture text (line endings depend on git autocrlf; readers split on CRLF or LF) */
export function fixtureText(name: FixtureName): string {
	return readFileSync(fileURLToPath(new URL(`./${name}.txt`, import.meta.url)), 'utf8')
}

export function fixtureLines(name: FixtureName): LwrpLine[] {
	const out: LwrpLine[] = []
	for (const l of fixtureText(name).split(/\r?\n/)) {
		const p = parseLine(l)
		if (p) out.push(p)
	}
	return out
}

/** A state with the whole fixture replayed */
export function loadedState(name: FixtureName): XNodeState {
	const state = new XNodeState(() => 1000)
	for (const l of fixtureLines(name)) state.applyLine(l)
	return state
}

/** Apply one raw line to a state */
export function apply(state: XNodeState, line: string): ReturnType<XNodeState['applyLine']> {
	const p = parseLine(line)
	if (!p) throw new Error(`not a line: ${line}`)
	return state.applyLine(p)
}
