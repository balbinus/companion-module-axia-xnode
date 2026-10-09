import { describe, expect, it } from 'vitest'
import { XNodeState } from '../../src/model/state.js'
import { apply, fixtureLines, loadedState } from '../fixtures/load.js'

const VER_LEGACY =
	'VER LWRP:1.2 DEVN:"axiaxnode.analog4x4" NSRC:8 NDST:8 NGPI:0 NGPO:0 PRODUCT:"Axia xNode" MODEL:"Analog 4x4 I/O" SVER:2.4.7-1 FPSTAT:1 KEY:6 MIXCFG:1 MIX:24'

function fresh(now = () => 5000): XNodeState {
	return new XNodeState(now)
}

describe('fixture replay: legacy analog4x4 (a)', () => {
	const s = loadedState('legacy-analog4x4-a')

	it('detects the model and counts', () => {
		expect(s.isXNode2).toBe(false)
		expect(s.hasMixer).toBe(true)
		expect([s.nsrc, s.ndst, s.nmix, s.ngpi, s.ngpo]).toEqual([8, 8, 24, 0, 0])
		expect(s.ioMap.model).toBe('analog4x4')
		expect(s.ver.PRODUCT).toBe('Axia xNode')
	})

	it('ignores the bogus VER INP:1 on legacy', () => {
		expect(s.ver.INP).toBe('1')
		expect(s.ninp).toBe(0)
	})

	it('loads IP and SET', () => {
		expect(s.ip).toEqual({ addr: '192.0.2.223', link: true, hostname: 'node-a-0' })
		expect(s.set.NID).toBe('223/0')
		expect(s.set.LWS_802_1p_TAGE).toBe('1')
		expect(s.set.LWCLK_ADDR).toBe('239.192.255.1')
	})

	it('loads SRC and DST objects, quoted and unquoted alike', () => {
		expect(s.src.size).toBe(8)
		expect(s.dst.size).toBe(8)
		expect(s.src.get(1)).toEqual({ PSNM: 'SRC 1', RTPE: '1', RTPP: '12', RTPA: '239.192.87.29' })
		expect(s.src.get(8)).toMatchObject({ RTPA: '239.192.87.36', INGN: '0' })
		expect(s.dst.get(1)).toEqual({ NAME: 'DST 1', ADDR: '239.193.87.29', NCHN: '2', VMOD: '*', OUGN: '0' })
		expect(s.srcName(3)).toBe('SRC 3')
		expect(s.dstName(8)).toBe('DST 8')
	})

	it('loads the mixer, with 17 crosspoints used', () => {
		expect(s.mixcfgMode).toBe(0)
		expect(s.mix.size).toBe(24)
		expect(s.xpointsUsed()).toBe(17)
		expect(s.getXpoint(1, 17)).toBe(0)
		expect(s.getXpoint(12, 10)).toBe(-100)
		expect(s.getXpoint(9, 1)).toBeUndefined()
		expect(s.mix.get(9)?.size).toBe(0)
	})

	it('has no INP, GPIO or levels', () => {
		expect(s.inp.size).toBe(0)
		expect(s.gpi.size + s.gpo.size + s.cfgGpo.size).toBe(0)
	})
})

describe('fixture replay: legacy analog4x4 (b)', () => {
	const s = loadedState('legacy-analog4x4-b')

	it('has no bogus INP and 28 crosspoints used', () => {
		expect(s.ver.INP).toBeUndefined()
		expect(s.ninp).toBe(0)
		expect(s.xpointsUsed()).toBe(28)
		expect(s.getXpoint(1, 15)).toBe(0)
		expect(s.getXpoint(1, 17)).toBe(0)
		expect(s.mix.get(15)?.size).toBe(0)
	})

	it('keeps user names and the labelled DST address', () => {
		expect(s.srcName(1)).toBe('MIX ANIM')
		expect(s.srcName(3)).toBe('TEL 1')
		expect(s.dst.get(2)?.ADDR).toBe('239.192.91.207 <Program 3@STD3-Engine>')
		expect(s.dstName(8)).toBe('TEST AUDIO')
		expect(s.set.NID).toBe('224/0')
		expect(s.set.LWIFS).toBe('eth0 eth1')
	})
})

describe('fixture replay: xNode2 combo', () => {
	const s = loadedState('xnode2-combo')

	it('detects xNode2 by DEVN and the model', () => {
		expect(s.isXNode2).toBe(true)
		expect(s.ioMap.model).toBe('combo')
		expect(s.ioMap.inputs).toHaveLength(25)
		expect([s.nsrc, s.ndst, s.nmix, s.ngpi, s.ngpo, s.ninp]).toEqual([8, 8, 24, 2, 2, 5])
	})

	it('loads IP', () => {
		expect(s.ip).toEqual({ addr: '192.0.2.225', link: true, hostname: 'xnode2-test' })
		expect(s.set).toEqual({})
	})

	it('loads SRC/DST/INP', () => {
		expect(s.src.size).toBe(8)
		expect(s.dst.size).toBe(8)
		expect(s.inp.size).toBe(5)
		expect(s.src.get(1)).toMatchObject({ PSNM: 'Sender1', LABL: '', RTPA: '239.192.1.0', NCHN: '2' })
		expect(s.dst.get(8)).toMatchObject({ NAME: 'Receiver8', ADDR: '239.192.2.7' })
		expect(s.inp.get(5)).toEqual({ GAIN: '0', NAME: 'Microphone 5', PHPW: '0', TYPE: 'MIC' })
		expect(s.inpName(4)).toBe('AES 4')
	})

	it('loads the mixer, with 18 crosspoints used', () => {
		expect(s.xpointsUsed()).toBe(18)
		expect(s.getXpoint(1, 17)).toBe(0)
		expect(s.getXpoint(9, 25)).toBe(0)
		expect(s.getXpoint(10, 25)).toBe(0)
		expect(s.mix.get(11)?.size).toBe(0)
		expect(s.mix.size).toBe(24)
	})

	it('loads GPIO (lower case) and CFG GPO', () => {
		expect(s.gpi.get(1)).toBe('hhhhh')
		expect(s.gpo.get(2)).toBe('hhhhh')
		expect(s.cfgGpo.get(1)).toEqual({ NAME: 'GPIO_1', SRCA: '' })
	})

	it('ignores BEGIN, END and unknown lines', () => {
		expect(apply(fresh(), 'BEGIN')).toBeNull()
		expect(apply(fresh(), 'END')).toBeNull()
		expect(apply(fresh(), 'ERROR 1001 syntax error')).toBeNull()
		expect(apply(fresh(), 'FOO 1 A:1')).toBeNull()
	})
})

describe('re-application', () => {
	it('returns null for every line when replaying a loaded fixture', () => {
		for (const name of ['legacy-analog4x4-a', 'legacy-analog4x4-b', 'xnode2-combo'] as const) {
			const s = loadedState(name)
			for (const l of fixtureLines(name)) expect(s.applyLine(l), l.raw).toBeNull()
		}
	})
})

describe('VER', () => {
	it('reports rebuild on first VER and on change, null when identical', () => {
		const s = fresh()
		expect(apply(s, VER_LEGACY)).toEqual({ kind: 'ver', rebuild: true })
		expect(apply(s, VER_LEGACY)).toBeNull()
		expect(apply(s, VER_LEGACY.replace('NSRC:8', 'NSRC:4'))).toEqual({ kind: 'ver', rebuild: true })
		expect(s.nsrc).toBe(4)
	})

	it('ignores an empty VER', () => {
		const s = fresh()
		expect(apply(s, 'VER')).toBeNull()
		expect(s.hasMixer).toBe(false)
	})

	it('has no mixer without MIX', () => {
		const s = fresh()
		apply(s, 'VER LWRP:1.2 DEVN:"axiaxnode.gpio" NSRC:0 NDST:0 NGPI:4 NGPO:4')
		expect(s.hasMixer).toBe(false)
		expect(s.ioMap.hasMixer).toBe(false)
		expect([s.ngpi, s.ngpo]).toEqual([4, 4])
	})

	it('rebuilds the I/O map when the model changes', () => {
		const s = fresh()
		apply(s, VER_LEGACY)
		expect(s.ioMap.model).toBe('analog4x4')
		apply(s, VER_LEGACY.replace('analog4x4', 'aes4x4'))
		expect(s.ioMap.model).toBe('aes4x4')
	})

	it('detects xNode2 by DEVN or by LWRP version >= 1.4', () => {
		const a = fresh()
		apply(a, 'VER LWRP:1.2 DEVN:"axiaxnode2.analog4x4" MIX:24 NSRC:8 NDST:8 INP:4')
		expect(a.isXNode2).toBe(true)
		expect(a.ninp).toBe(4)

		const b = fresh()
		apply(b, 'VER LWRP:1.4.2 DEVN:"somethingelse" INP:3')
		expect(b.isXNode2).toBe(true)
		expect(b.ninp).toBe(3)

		const c = fresh()
		apply(c, 'VER LWRP:2.0 DEVN:"x"')
		expect(c.isXNode2).toBe(true)

		const d = fresh()
		apply(d, 'VER LWRP:1.3 DEVN:"axiaxnode.combo" INP:3')
		expect(d.isXNode2).toBe(false)
		expect(d.ninp).toBe(0)

		const e = fresh()
		apply(e, 'VER LWRP:1.10 DEVN:"axiaxnode.combo"')
		expect(e.isXNode2).toBe(true)

		const f = fresh()
		apply(f, 'VER DEVN:"AxiaXNode2.COMBO"')
		expect(f.isXNode2).toBe(true)
	})
})

describe('IP', () => {
	it('merges address, link and hostname', () => {
		const s = fresh()
		expect(apply(s, 'IP ADDR:"192.0.2.1" LINK:1')).toEqual({ kind: 'ip', rebuild: false })
		expect(apply(s, 'IP hostname node-x')).toEqual({ kind: 'ip', rebuild: false })
		expect(s.ip).toEqual({ addr: '192.0.2.1', link: true, hostname: 'node-x' })
		expect(apply(s, 'IP ADDR:"192.0.2.1" LINK:1')).toBeNull()
		expect(apply(s, 'IP ADDR:192.0.2.1 LINK:0')).toEqual({ kind: 'ip', rebuild: false })
		expect(s.ip.link).toBe(false)
	})
})

describe('SET', () => {
	it('merges attributes', () => {
		const s = fresh()
		expect(apply(s, 'SET NID:1/0 PTP_DOM:0')).toEqual({ kind: 'set', rebuild: false })
		expect(apply(s, 'SET PTP_DOM:1')).toEqual({ kind: 'set', rebuild: false })
		expect(s.set).toEqual({ NID: '1/0', PTP_DOM: '1' })
		expect(apply(s, 'SET')).toBeNull()
		expect(apply(s, 'SET NID:1/0')).toBeNull()
	})
})

describe('SRC / DST / INP merge', () => {
	it('merges attributes instead of replacing', () => {
		const s = fresh()
		apply(s, 'SRC 1 PSNM:"A" RTPE:1')
		expect(apply(s, 'SRC 1 INGN:-20')).toEqual({ kind: 'src', index: 1, rebuild: false })
		expect(s.src.get(1)).toEqual({ PSNM: 'A', RTPE: '1', INGN: '-20' })
		apply(s, 'DST 3 NAME:"B" ADDR:"22302"')
		apply(s, 'DST 3 ADDR:""')
		expect(s.dst.get(3)).toEqual({ NAME: 'B', ADDR: '' })
	})

	it('keeps NAME/TYPE on a partial INP push', () => {
		const s = loadedState('xnode2-combo')
		expect(apply(s, 'INP 5 GAIN:210')).toEqual({ kind: 'inp', index: 5, rebuild: false })
		expect(s.inp.get(5)).toEqual({ GAIN: '210', NAME: 'Microphone 5', PHPW: '0', TYPE: 'MIC' })
	})

	it('flags rebuild only when a name changes', () => {
		const s = fresh()
		expect(apply(s, 'SRC 1 PSNM:"A" RTPE:1')).toMatchObject({ kind: 'src', rebuild: true })
		expect(apply(s, 'SRC 1 RTPE:0')).toMatchObject({ rebuild: false })
		expect(apply(s, 'SRC 1 PSNM:"A"')).toBeNull()
		expect(apply(s, 'SRC 1 PSNM:"B"')).toMatchObject({ rebuild: true })
		expect(apply(s, 'DST 1 NAME:"X"')).toMatchObject({ kind: 'dst', rebuild: true })
		expect(apply(s, 'DST 1 ADDR:"1"')).toMatchObject({ kind: 'dst', rebuild: false })
		expect(apply(s, 'INP 2 NAME:"Y"')).toMatchObject({ kind: 'inp', index: 2, rebuild: true })
		expect(apply(s, 'INP 2 GAIN:5')).toMatchObject({ rebuild: false })
		expect(apply(s, 'CFG GPO 1 NAME:"G"')).toEqual({ kind: 'cfgGpo', index: 1, rebuild: true })
		expect(apply(s, 'CFG GPO 1 SRCA:"22302"')).toEqual({ kind: 'cfgGpo', index: 1, rebuild: false })
	})

	it('flags rebuild when a name is cleared', () => {
		const s = fresh()
		apply(s, 'SRC 1 PSNM:"A"')
		expect(apply(s, 'SRC 1 PSNM:""')).toMatchObject({ rebuild: true })
		expect(s.srcName(1)).toBeUndefined()
	})

	it('ignores invalid indexes', () => {
		const s = fresh()
		expect(apply(s, 'SRC 0 PSNM:"A"')).toBeNull()
		expect(apply(s, 'SRC x PSNM:"A"')).toBeNull()
		expect(apply(s, 'SRC PSNM:"A"')).toBeNull()
		expect(apply(s, 'SRC -1 PSNM:"A"')).toBeNull()
		expect(apply(s, 'SRC 1.5 PSNM:"A"')).toBeNull()
		expect(s.src.size).toBe(0)
	})

	it('does not store an empty object for an attribute-less line', () => {
		const s = fresh()
		expect(apply(s, 'SRC 2')).toBeNull()
		expect(s.srcName(2)).toBeUndefined()
	})

	it('only handles CFG GPO', () => {
		const s = fresh()
		expect(apply(s, 'CFG GPI 1 NAME:"x"')).toBeNull()
		expect(apply(s, 'CFG')).toBeNull()
	})
})

describe('MIX', () => {
	it('sets, replaces and clears rows', () => {
		const s = fresh()
		expect(apply(s, 'MIX 9 1:-60 3:-25')).toEqual({ kind: 'mix', index: 9, rebuild: false })
		expect(s.getXpoint(9, 1)).toBe(-60)
		expect(s.getXpoint(9, 3)).toBe(-25)
		// the row replaces the previous one: input 3 is now off
		expect(apply(s, 'MIX 9 1:-10')).toEqual({ kind: 'mix', index: 9, rebuild: false })
		expect(s.getXpoint(9, 1)).toBe(-10)
		expect(s.getXpoint(9, 3)).toBeUndefined()
	})

	it('treats "1:-" as cleared', () => {
		const s = fresh()
		apply(s, 'MIX 9 1:0 2:0')
		expect(apply(s, 'MIX 9 1:- 2:0')).not.toBeNull()
		expect(s.getXpoint(9, 1)).toBeUndefined()
		expect(s.getXpoint(9, 2)).toBe(0)
	})

	it('stores -1000 but does not count it as on; <= -1001 means cleared', () => {
		const s = fresh()
		apply(s, 'MIX 9 1:-1000 2:-1001 3:-5000 4:-999')
		expect(s.getXpoint(9, 1)).toBe(-1000)
		expect(s.getXpoint(9, 2)).toBeUndefined()
		expect(s.getXpoint(9, 3)).toBeUndefined()
		expect(s.getXpoint(9, 4)).toBe(-999)
		expect(s.xpointsUsed()).toBe(1)
	})

	it('accepts gains above +24 dB as sent by the device and positive values', () => {
		const s = fresh()
		apply(s, 'MIX 9 1:240 2:1000')
		expect(s.getXpoint(9, 1)).toBe(240)
		expect(s.getXpoint(9, 2)).toBe(1000)
	})

	it('drops non-integer and non-numeric gains', () => {
		const s = fresh()
		apply(s, 'MIX 9 1:2.5 2:abc 3:0')
		expect(s.getXpoint(9, 1)).toBeUndefined()
		expect(s.getXpoint(9, 2)).toBeUndefined()
		expect(s.getXpoint(9, 3)).toBe(0)
	})

	it('handles the legacy empty row (trailing space) as a clear', () => {
		const s = fresh()
		apply(s, 'MIX 9 1:0 5:0')
		expect(apply(s, 'MIX 9 ')).toEqual({ kind: 'mix', index: 9, rebuild: false })
		expect(s.mix.get(9)?.size).toBe(0)
		expect(s.xpointsUsed()).toBe(0)
	})

	it('reports no change for an identical row and for an empty first row', () => {
		const s = fresh()
		expect(apply(s, 'MIX 9')).toBeNull()
		expect(s.mix.has(9)).toBe(true)
		apply(s, 'MIX 10 1:0 2:-5')
		expect(apply(s, 'MIX 10 2:-5 1:0')).toBeNull()
	})

	it('ignores non-numeric keys and invalid rows', () => {
		const s = fresh()
		apply(s, 'MIX 9 FOO:1 0:0 1:0')
		expect([...s.mix.get(9)!.keys()]).toEqual([1])
		expect(apply(s, 'MIX 0 1:0')).toBeNull()
		expect(apply(s, 'MIX x 1:0')).toBeNull()
		expect(apply(s, 'MIX 1:0')).toBeNull()
	})

	// BUG: an empty crosspoint value ("MIX 9 3:") is read as Number('') = 0, i.e. an active 0 dB crosspoint
	it.fails('does not turn an empty crosspoint value into 0 dB', () => {
		const s = fresh()
		apply(s, 'MIX 9 3:')
		expect(s.getXpoint(9, 3)).toBeUndefined()
	})

	it('counts crosspoints across rows', () => {
		const s = fresh()
		apply(s, 'MIX 1 1:0 2:0')
		apply(s, 'MIX 2 1:-1000')
		apply(s, 'MIX 3 1:-5')
		expect(s.xpointsUsed()).toBe(3)
	})
})

describe('MIXCFG', () => {
	it('tracks the mode', () => {
		const s = fresh()
		expect(apply(s, 'MIXCFG MODE:5')).toEqual({ kind: 'mixcfg', rebuild: false })
		expect(s.mixcfgMode).toBe(5)
		expect(apply(s, 'MIXCFG MODE:5')).toBeNull()
		expect(apply(s, 'MIXCFG MODE:0')).toEqual({ kind: 'mixcfg', rebuild: false })
		expect(s.mixcfgMode).toBe(0)
	})

	it('ignores lines without a numeric mode', () => {
		const s = fresh()
		expect(apply(s, 'MIXCFG')).toBeNull()
		expect(apply(s, 'MIXCFG MODE:x')).toBeNull()
		expect(s.mixcfgMode).toBeUndefined()
	})
})

describe('GPIO', () => {
	it('stores pins in lower case, also when the device pushes the changed pin in upper case', () => {
		const s = fresh()
		expect(apply(s, 'GPO 2 hhhhh')).toEqual({ kind: 'gpo', index: 2, rebuild: false })
		expect(apply(s, 'GPO 2 hhLhh')).toEqual({ kind: 'gpo', index: 2, rebuild: false })
		expect(s.gpo.get(2)).toBe('hhlhh')
		expect(apply(s, 'GPO 2 hhHhh')).toEqual({ kind: 'gpo', index: 2, rebuild: false })
		expect(s.gpo.get(2)).toBe('hhhhh')
	})

	it('reports no change when the state is the same, even if the case differs', () => {
		const s = fresh()
		apply(s, 'GPI 1 hhlhh')
		expect(apply(s, 'GPI 1 hhlhh')).toBeNull()
		expect(apply(s, 'GPI 1 hhLhh')).toBeNull()
		expect(s.gpi.get(1)).toBe('hhlhh')
	})

	it('keeps GPI and GPO separate', () => {
		const s = fresh()
		apply(s, 'GPI 1 lllll')
		expect(s.gpo.size).toBe(0)
		expect(s.gpi.get(1)).toBe('lllll')
	})

	it('ignores malformed lines', () => {
		const s = fresh()
		expect(apply(s, 'GPO 1')).toBeNull()
		expect(apply(s, 'GPO 0 hhhhh')).toBeNull()
		expect(apply(s, 'GPO 1 xxxxx')).toBeNull()
		expect(apply(s, 'GPO x hhhhh')).toBeNull()
		expect(s.gpo.size).toBe(0)
	})
})

describe('LVL', () => {
	it('tracks low and clip transitions per side', () => {
		const s = fresh(() => 1234)
		expect(apply(s, 'LVL ICH 1.L NO-LOW')).toEqual({ kind: 'lvl', index: 1, group: 'ICH', rebuild: false })
		expect(s.lvl.ICH.get(1)?.L).toEqual({ low: false, updatedAt: 1234 })
		expect(apply(s, 'LVL ICH 1.L LOW')).not.toBeNull()
		expect(s.lvl.ICH.get(1)?.L?.low).toBe(true)
		expect(apply(s, 'LVL ICH 1.L LOW')).toBeNull()
		expect(apply(s, 'LVL ICH 1.L CLIP')).not.toBeNull()
		expect(s.lvl.ICH.get(1)?.L).toMatchObject({ low: true, clip: true })
		expect(apply(s, 'LVL ICH 1.L NO-CLIP')).not.toBeNull()
		expect(s.lvl.ICH.get(1)?.L).toMatchObject({ low: true, clip: false })
		expect(s.lvl.ICH.get(1)?.R).toBeUndefined()
	})

	it('keeps channels and groups separate', () => {
		const s = fresh()
		apply(s, 'LVL ICH 1.R LOW')
		apply(s, 'LVL OCH 1.R NO-LOW')
		apply(s, 'LVL ICH 2.L CLIP')
		expect(s.lvl.ICH.get(1)?.R?.low).toBe(true)
		expect(s.lvl.OCH.get(1)?.R?.low).toBe(false)
		expect(s.lvl.ICH.get(2)?.L?.clip).toBe(true)
		expect(s.lvl.HWI.size).toBe(0)
	})

	it('handles mono channels (.1) and hardware groups', () => {
		const s = fresh()
		expect(apply(s, 'LVL HWI 5.1 LOW')).toEqual({ kind: 'lvl', index: 5, group: 'HWI', rebuild: false })
		expect(s.lvl.HWI.get(5)?.mono?.low).toBe(true)
		expect(s.lvl.HWI.get(5)?.L).toBeUndefined()
		expect(apply(s, 'LVL HWO 2.L NO-CLIP')).toMatchObject({ group: 'HWO' })
	})

	it('only updates the timestamp on changes', () => {
		let t = 1
		const s = fresh(() => t)
		apply(s, 'LVL ICH 1.L LOW')
		t = 2
		expect(apply(s, 'LVL ICH 1.L LOW')).toBeNull()
		expect(s.lvl.ICH.get(1)?.L?.updatedAt).toBe(1)
		apply(s, 'LVL ICH 1.L NO-LOW')
		expect(s.lvl.ICH.get(1)?.L?.updatedAt).toBe(2)
	})

	it('ignores malformed lines', () => {
		const s = fresh()
		for (const l of [
			'LVL',
			'LVL ICH 1',
			'LVL ICH 1.L',
			'LVL ICH 1.X LOW',
			'LVL FOO 1.L LOW',
			'LVL ICH x.L LOW',
			'LVL ICH 1.L WAT',
		]) {
			expect(apply(s, l), l).toBeNull()
		}
	})
})

describe('MTR', () => {
	it('parses stereo readings', () => {
		const s = fresh(() => 99)
		expect(apply(s, 'MTR ICH 1 PEEK:-1000:-1000')).toEqual({ kind: 'mtr', index: 1, group: 'ICH', rebuild: false })
		expect(s.mtr.ICH.get(1)).toEqual({ l: -1000, r: -1000, updatedAt: 99 })
		apply(s, 'MTR OCH 2 PEEK:-123:-45')
		expect(s.mtr.OCH.get(2)).toMatchObject({ l: -123, r: -45 })
		apply(s, 'MTR OCH 3 PEEK:0:-5')
		expect(s.mtr.OCH.get(3)).toMatchObject({ l: 0, r: -5 })
	})

	it('parses mono readings with a single value', () => {
		const s = fresh()
		apply(s, 'MTR HWI 5 PEEK:-1000')
		expect(s.mtr.HWI.get(5)?.l).toBe(-1000)
		expect(s.mtr.HWI.get(5)?.r).toBeUndefined()
	})

	it('reports no change for identical values but refreshes the timestamp', () => {
		let t = 1
		const s = fresh(() => t)
		apply(s, 'MTR ICH 1 PEEK:-100:-200')
		t = 2
		expect(apply(s, 'MTR ICH 1 PEEK:-100:-200')).toBeNull()
		expect(s.mtr.ICH.get(1)?.updatedAt).toBe(2)
		expect(apply(s, 'MTR ICH 1 PEEK:-100:-201')).not.toBeNull()
	})

	it('ignores malformed lines', () => {
		const s = fresh()
		for (const l of [
			'MTR',
			'MTR ICH 1',
			'MTR ICH 1 PEEK:abc',
			'MTR FOO 1 PEEK:-1',
			'MTR ICH 0 PEEK:-1',
			'MTR ICH x PEEK:-1',
		]) {
			expect(apply(s, l), l).toBeNull()
		}
	})
})

describe('reset', () => {
	it('returns to the initial state, keeps the clock, and works afterwards', () => {
		const s = loadedState('xnode2-combo') // clock fixed at 1000
		s.reset()
		expect(s.ver).toEqual({})
		expect(s.isXNode2).toBe(false)
		expect(s.hasMixer).toBe(false)
		expect([s.nsrc, s.ndst, s.nmix, s.ngpi, s.ngpo, s.ninp]).toEqual([0, 0, 0, 0, 0, 0])
		expect(s.ioMap.hasMixer).toBe(false)
		expect(s.src.size + s.dst.size + s.inp.size + s.mix.size + s.gpi.size + s.gpo.size + s.cfgGpo.size).toBe(0)
		expect(s.ip).toEqual({})
		expect(s.set).toEqual({})
		expect(s.mixcfgMode).toBeUndefined()
		expect(s.xpointsUsed()).toBe(0)
		apply(s, 'LVL ICH 1.L LOW')
		expect(s.lvl.ICH.get(1)?.L?.updatedAt).toBe(1000)
		// a fresh load behaves like on a new object, including rebuild flags
		expect(apply(s, VER_LEGACY)).toEqual({ kind: 'ver', rebuild: true })
	})

	it('does not share maps with the previous content', () => {
		const s = fresh()
		apply(s, 'SRC 1 PSNM:"A"')
		const oldSrc = s.src
		s.reset()
		apply(s, 'SRC 1 PSNM:"B"')
		expect(oldSrc.get(1)?.PSNM).toBe('A')
		expect(s.src.get(1)?.PSNM).toBe('B')
	})

	it('keeps the injected clock', () => {
		const s = fresh(() => 777)
		s.reset()
		apply(s, 'MTR ICH 1 PEEK:-1')
		expect(s.mtr.ICH.get(1)?.updatedAt).toBe(777)
	})
})

describe('name lookup', () => {
	it('returns undefined for missing or empty names', () => {
		const s = fresh()
		apply(s, 'SRC 1 PSNM:""')
		expect(s.srcName(1)).toBeUndefined()
		expect(s.srcName(2)).toBeUndefined()
		expect(s.dstName(1)).toBeUndefined()
		expect(s.inpName(1)).toBeUndefined()
	})
})
