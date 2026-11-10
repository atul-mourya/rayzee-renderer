//! The binned-SAH build of `BVHBuilder.buildNodeRecursive` / `buildNodeRecursiveToDepth`
//! (rayzee/src/bvh/BVHBuilder.js), compiled to wasm32. It builds the same tree: f32 storage, f64
//! arithmetic in the same order, the same comparisons (NaN included) and the same swaps.
//!
//! One instance builds once. The host writes `count` references at `reserve()`'s offset, calls
//! `build()`, then reads the nodes (pre-order, 8 u32 each) and the references in their new order.

#![no_std]
#![allow(static_mut_refs, clippy::missing_safety_doc)]

use core::arch::wasm32::{self, f32x4_extract_lane, f32x4_pmax, f32x4_pmin, f32x4_splat, v128};
use core::ptr::{read_unaligned, write_unaligned};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
	wasm32::unreachable()
}

#[link(wasm_import_module = "env")]
extern "C" {
	/// Triangles placed in leaves since the last call.
	fn progress(triangles: u32);
}

/// A triangle's box, centroid and index: written by the host, swapped by the build.
#[repr(C)]
#[derive(Clone, Copy)]
struct Ref {
	mn: [f32; 3],
	mx: [f32; 3],
	c: [f32; 3],
	id: u32,
}

const REF_BYTES: usize = 40;
/// A node: box (6 f32), then `a`, `b`: inner `right, INNER`, leaf `offset, count`, frontier `task, FRONTIER`.
const NODE_U32: usize = 8;
const INNER: u32 = 0xFFFF_FFFF;
const FRONTIER: u32 = 0xFFFF_FFFE;
/// A frontier task: start, end, depth, box (6 f32).
const TASK_U32: usize = 9;
const MAX_TASKS: usize = 4096;
const MAX_BINS: usize = 128;
const PROGRESS_STEP: u32 = 1 << 16;

const SAH: u8 = 1;
const OBJECT_MEDIAN: u8 = 2;
const SPATIAL_MEDIAN: u8 = 3;

struct Config {
	max_leaf: usize,
	min_bins: usize,
	max_bins: usize,
	traversal: f64,
	intersection: f64,
	object_median: bool,
	spatial_median: bool,
}

static mut CFG: Config = Config {
	max_leaf: 8,
	min_bins: 8,
	max_bins: 64,
	traversal: 1.0,
	intersection: 2.5,
	object_median: true,
	spatial_median: true,
};

static mut REFS: *mut Ref = core::ptr::null_mut();
static mut NODES: *mut u32 = core::ptr::null_mut();
static mut NODE_CAP: usize = 0;
static mut NODE_COUNT: usize = 0;
static mut OUT_OF_MEMORY: bool = false;
static mut PENDING: u32 = 0;

static mut TASKS: [u32; TASK_U32 * MAX_TASKS] = [0; TASK_U32 * MAX_TASKS];
static mut TASK_COUNT: usize = 0;

/// sahSplits, objectMedianSplits, spatialMedianSplits, failedSplits, totalSplitAttempts, avgBinsUsed.
static mut STATS: [f64; 6] = [0.0; 6];

static mut BIN_COUNT: [[u32; MAX_BINS]; 3] = [[0; MAX_BINS]; 3];
// Boxes are 4 lanes, x y z and one ignored: `pmin( box, v )` is `v < box ? v : box`, the scalar test lane by lane.
static mut BIN_MIN: [[[f32; 4]; MAX_BINS]; 3] = [[[0.0; 4]; MAX_BINS]; 3];
static mut BIN_MAX: [[[f32; 4]; MAX_BINS]; 3] = [[[0.0; 4]; MAX_BINS]; 3];
static mut LEFT_COUNT: [u32; MAX_BINS] = [0; MAX_BINS];
static mut LEFT_MIN: [[f32; 4]; MAX_BINS] = [[0.0; 4]; MAX_BINS];
static mut LEFT_MAX: [[f32; 4]; MAX_BINS] = [[0.0; 4]; MAX_BINS];
static mut RIGHT_COUNT: [u32; MAX_BINS] = [0; MAX_BINS];
static mut RIGHT_MIN: [[f32; 4]; MAX_BINS] = [[0.0; 4]; MAX_BINS];
static mut RIGHT_MAX: [[f32; 4]; MAX_BINS] = [[0.0; 4]; MAX_BINS];

fn ensure(end: usize) -> bool {
	let have = wasm32::memory_size(0) * 65536;
	if end <= have {
		return true;
	}
	wasm32::memory_grow(0, (end - have).div_ceil(65536)) != usize::MAX
}

/// Room for `count` references and a first share of nodes; returns the references' byte offset, 0 if none.
#[no_mangle]
pub unsafe extern "C" fn reserve(count: u32) -> u32 {
	let count = count as usize;
	let base = wasm32::memory_size(0) * 65536;
	let Some(refs_bytes) = count.checked_mul(REF_BYTES) else { return 0 };
	let nodes = base + refs_bytes;
	let cap = count / 2 + 64;
	if !ensure(nodes + cap * NODE_U32 * 4) {
		return 0;
	}
	REFS = base as *mut Ref;
	NODES = nodes as *mut u32;
	NODE_CAP = cap;
	base as u32
}

#[no_mangle]
pub unsafe extern "C" fn nodes() -> u32 {
	NODES as u32
}

#[no_mangle]
pub unsafe extern "C" fn tasks() -> u32 {
	TASKS.as_ptr() as u32
}

#[no_mangle]
pub unsafe extern "C" fn task_count() -> u32 {
	TASK_COUNT as u32
}

#[no_mangle]
pub unsafe extern "C" fn stats() -> u32 {
	STATS.as_ptr() as u32
}

/// `BVHBuilder.sortTrianglesByMortonCode` on the references: codes from the centroids' box at
/// `bits` per axis, a stable sort by code, the references moved into that order. 0 when out of memory.
#[no_mangle]
pub unsafe extern "C" fn sort(count: u32, bits: u32) -> u32 {
	let n = count as usize;
	let scratch = NODES as usize;
	if !ensure(scratch + n * 12) {
		return 0;
	}
	let keys = scratch as *mut u32;
	let order = keys.add(n);
	let temp = order.add(n);

	let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
	for i in 0..n {
		let c = &r(i).c;
		for a in 0..3 {
			if c[a] < lo[a] { lo[a] = c[a]; }
			if c[a] > hi[a] { hi[a] = c[a]; }
		}
	}
	let top = ((1u32 << bits) - 1) as f64;
	let mut inv = [0.0f64; 3];
	for a in 0..3 {
		let range = hi[a] as f64 - lo[a] as f64;
		inv[a] = if range > 0.0 { top / range } else { 0.0 };
	}
	let spread = |v: u32| -> u32 {
		let v = v.wrapping_mul(0x0001_0001) & 0xFF00_00FF;
		let v = v.wrapping_mul(0x0000_0101) & 0x0F00_F00F;
		let v = v.wrapping_mul(0x0000_0011) & 0xC30C_30C3;
		v.wrapping_mul(0x0000_0005) & 0x4924_9249
	};
	for i in 0..n {
		let c = &r(i).c;
		let mut q = [0u32; 3];
		for a in 0..3 {
			let m = (c[a] as f64 - lo[a] as f64) * inv[a];
			// `m < 0 ? 0 : ( m > top ? top : m ) | 0`: NaN falls through to 0, as `| 0` makes it.
			q[a] = if m < 0.0 { 0 } else if m > top { top as u32 } else { m as i32 as u32 };
		}
		*keys.add(i) = (spread(q[2]) << 2) + (spread(q[1]) << 1) + spread(q[0]);
		*order.add(i) = i as u32;
	}

	let mut counts = [0u32; 256];
	for shift in (0..32).step_by(8) {
		counts.fill(0);
		for i in 0..n {
			counts[((*keys.add(*order.add(i) as usize) >> shift) & 0xFF) as usize] += 1;
		}
		let mut total = 0;
		for c in counts.iter_mut() {
			let k = *c;
			*c = total;
			total += k;
		}
		for i in 0..n {
			let id = *order.add(i);
			let d = ((*keys.add(id as usize) >> shift) & 0xFF) as usize;
			*temp.add(counts[d] as usize) = id;
			counts[d] += 1;
		}
		core::ptr::copy_nonoverlapping(temp, order, n);
	}

	// Slot j takes reference order[ j ], each cycle followed with one reference held aside.
	const DONE: u32 = 1 << 31;
	for j in 0..n {
		if *order.add(j) & DONE != 0 {
			continue;
		}
		let held = *r(j);
		let mut k = j;
		loop {
			let s = *order.add(k) as usize;
			*order.add(k) |= DONE;
			if s == j {
				*r(k) = held;
				break;
			}
			*r(k) = *r(s);
			k = s;
		}
	}
	1
}

/// Builds `[0, count)`; returns the node count, or −1 when memory or the task table ran out.
/// `frontier` levels down, a range past 16 leaves becomes a task (`buildNodeRecursiveToDepth`);
/// a frontier deeper than the tree is `buildNodeRecursive`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn build(
	count: u32, depth: i32, frontier: i32, max_leaf: u32, min_bins: u32, max_bins: u32,
	traversal: f64, intersection: f64, flags: u32, has_box: u32,
	b0: f32, b1: f32, b2: f32, b3: f32, b4: f32, b5: f32,
) -> i32 {
	CFG = Config {
		max_leaf: max_leaf as usize,
		min_bins: min_bins as usize,
		max_bins: max_bins as usize,
		traversal,
		intersection,
		object_median: flags & 1 != 0,
		spatial_median: flags & 2 != 0,
	};
	let n = count as usize;
	let mut b = range_bounds(0, n);
	if has_box != 0 {
		b.mn = wasm32::f32x4(b0, b1, b2, 0.0);
		b.mx = wasm32::f32x4(b3, b4, b5, 0.0);
	}
	node(0, n, depth, frontier, b);
	if PENDING > 0 {
		progress(PENDING);
		PENDING = 0;
	}
	if OUT_OF_MEMORY { -1 } else { NODE_COUNT as i32 }
}

/// A box as x y z lanes (the fourth ignored) and the centroids' box the same way.
#[derive(Clone, Copy)]
struct Bounds {
	mn: v128,
	mx: v128,
	cmn: v128,
	cmx: v128,
}

#[inline(always)]
fn lane(v: v128, k: usize) -> f32 {
	match k {
		0 => f32x4_extract_lane::<0>(v),
		1 => f32x4_extract_lane::<1>(v),
		_ => f32x4_extract_lane::<2>(v),
	}
}

#[inline(always)]
fn empty() -> Bounds {
	Bounds {
		mn: f32x4_splat(f32::INFINITY),
		mx: f32x4_splat(f32::NEG_INFINITY),
		cmn: f32x4_splat(f32::INFINITY),
		cmx: f32x4_splat(f32::NEG_INFINITY),
	}
}

/// Reference `i`'s lanes: `mn0 mn1 mn2 mx0`, `mx0 mx1 mx2 c0` and `c0 c1 c2 id` (each read at its own offset).
#[inline(always)]
unsafe fn lanes(i: usize) -> (v128, v128, v128) {
	let p = REFS.add(i) as *const u8;
	(read_unaligned(p as *const v128), read_unaligned(p.add(12) as *const v128), read_unaligned(p.add(24) as *const v128))
}

#[inline(always)]
fn grow(b: &mut Bounds, lo: v128, hi: v128, c: v128) {
	b.mn = f32x4_pmin(b.mn, lo);
	b.mx = f32x4_pmax(b.mx, hi);
	b.cmn = f32x4_pmin(b.cmn, c);
	b.cmx = f32x4_pmax(b.cmx, c);
}

#[inline(always)]
unsafe fn r(i: usize) -> &'static mut Ref {
	&mut *REFS.add(i)
}

unsafe fn range_bounds(start: usize, end: usize) -> Bounds {
	let mut b = empty();
	for i in start..end {
		let (lo, hi, c) = lanes(i);
		grow(&mut b, lo, hi, c);
	}
	b
}

unsafe fn new_node(b: &Bounds, a: u32, k: u32) -> usize {
	if NODE_COUNT == NODE_CAP {
		let cap = NODE_CAP * 2;
		if !ensure(NODES as usize + cap * NODE_U32 * 4) {
			OUT_OF_MEMORY = true;
			return usize::MAX;
		}
		NODE_CAP = cap;
	}
	let i = NODE_COUNT;
	NODE_COUNT += 1;
	let p = NODES.add(i * NODE_U32);
	for j in 0..3 {
		*p.add(j) = lane(b.mn, j).to_bits();
		*p.add(3 + j) = lane(b.mx, j).to_bits();
	}
	*p.add(6) = a;
	*p.add(7) = k;
	i
}

unsafe fn leaf(start: usize, count: usize, b: &Bounds) {
	new_node(b, start as u32, count as u32);
	PENDING += count as u32;
	if PENDING >= PROGRESS_STEP {
		progress(PENDING);
		PENDING = 0;
	}
}

unsafe fn frontier_task(start: usize, end: usize, depth: i32, b: &Bounds) {
	if TASK_COUNT == MAX_TASKS {
		OUT_OF_MEMORY = true;
		return;
	}
	let id = TASK_COUNT;
	TASK_COUNT += 1;
	let t = &mut TASKS[id * TASK_U32..id * TASK_U32 + TASK_U32];
	t[0] = start as u32;
	t[1] = end as u32;
	t[2] = depth as u32;
	for j in 0..3 {
		t[3 + j] = lane(b.mn, j).to_bits();
		t[6 + j] = lane(b.mx, j).to_bits();
	}
	new_node(b, id as u32, FRONTIER);
}

unsafe fn node(start: usize, end: usize, depth: i32, frontier: i32, b: Bounds) {
	if OUT_OF_MEMORY {
		return;
	}
	let count = end - start;
	let cfg = &CFG;
	if count <= cfg.max_leaf || depth <= 0 {
		leaf(start, count, &b);
		return;
	}
	if frontier <= 0 && count > cfg.max_leaf * 16 {
		frontier_task(start, end, depth, &b);
		return;
	}

	let Some((axis, pos, method)) = find_split(start, end, &b) else {
		STATS[3] += 1.0;
		if frontier > 0 || count <= cfg.max_leaf * 16 {
			leaf(start, count, &b);
		} else {
			frontier_task(start, end, depth, &b);
		}
		return;
	};
	STATS[method as usize - 1] += 1.0;

	let (mid, left, right) = partition(start, end, axis, pos);
	if mid == start || mid == end {
		leaf(start, count, &b);
		return;
	}

	let me = new_node(&b, 0, INNER);
	if me == usize::MAX {
		return;
	}
	node(start, mid, depth - 1, frontier - 1, left);
	*NODES.add(me * NODE_U32 + 6) = NODE_COUNT as u32;
	node(mid, end, depth - 1, frontier - 1, right);
}

/// Splits `[start, end)` at `c[axis] <= pos`; returns the first right index and both sides' bounds.
/// A side's centroid box is the same set's as a pass over it after the split: min and max do not
/// depend on order, but for which zero a ±0 tie keeps, which no use of it can tell apart.
unsafe fn partition(start: usize, end: usize, axis: usize, pos: f64) -> (usize, Bounds, Bounds) {
	let mut lo = start as isize;
	let mut hi = end as isize - 1;
	let mut l = empty();
	let mut rb = empty();
	while lo <= hi {
		let i = lo as usize;
		let (a, b, c) = lanes(i);
		if (r(i).c[axis] as f64) <= pos {
			grow(&mut l, a, b, c);
			lo += 1;
		} else {
			grow(&mut rb, a, b, c);
			let t = *r(i);
			*r(i) = *r(hi as usize);
			*r(hi as usize) = t;
			hi -= 1;
		}
	}
	(lo as usize, l, rb)
}

fn bins_for(count: usize, cfg: &Config) -> usize {
	if count <= 16 { cfg.min_bins } else if count <= 64 { 16 } else if count <= 256 { 32 } else if count <= 1024 { 48 } else { cfg.max_bins }
}

#[inline(always)]
fn area(mn: v128, mx: v128) -> f64 {
	let dx = lane(mx, 0) as f64 - lane(mn, 0) as f64;
	let dy = lane(mx, 1) as f64 - lane(mn, 1) as f64;
	let dz = lane(mx, 2) as f64 - lane(mn, 2) as f64;
	2.0 * (dx * dy + dy * dz + dz * dx)
}

#[inline(always)]
unsafe fn ld(p: *const [f32; 4]) -> v128 {
	read_unaligned(p as *const v128)
}

#[inline(always)]
unsafe fn st(p: *mut [f32; 4], v: v128) {
	write_unaligned(p as *mut v128, v)
}

unsafe fn find_split(start: usize, end: usize, b: &Bounds) -> Option<(usize, f64, u8)> {
	let cfg = &CFG;
	let parent = area(b.mn, b.mx);
	let count = end - start;
	let leaf_cost = cfg.intersection * count as f64;
	let nb = bins_for(count, cfg);
	if nb == 0 || nb > MAX_BINS {
		wasm32::unreachable();
	}

	STATS[4] += 1.0;
	STATS[5] = (STATS[5] * (STATS[4] - 1.0) + nb as f64) / STATS[4];

	let cmin = [lane(b.cmn, 0), lane(b.cmn, 1), lane(b.cmn, 2)];
	let cmax = [lane(b.cmx, 0), lane(b.cmx, 1), lane(b.cmx, 2)];
	let mut live = [false; 3];
	let mut lo = [0.0f64; 3];
	let mut scale = [0.0f64; 3];
	for a in 0..3 {
		let (mn, mx) = (cmin[a] as f64, cmax[a] as f64);
		if mx - mn < 1e-6 {
			continue;
		}
		live[a] = true;
		lo[a] = mn;
		scale[a] = nb as f64 / (mx - mn);
		BIN_COUNT[a][..nb].fill(0);
		BIN_MIN[a][..nb].fill([f32::INFINITY; 4]);
		BIN_MAX[a][..nb].fill([f32::NEG_INFINITY; 4]);
	}
	if !(live[0] || live[1] || live[2]) {
		return fallback(start, end);
	}

	for i in start..end {
		let (vlo, vhi, _) = lanes(i);
		let c = &r(i).c;
		for a in 0..3 {
			if !live[a] {
				continue;
			}
			let f = (c[a] as f64 - lo[a]) * scale[a];
			if f != f {
				continue;
			}
			let mut k = f as usize;
			if k >= nb { k = nb - 1; }
			*BIN_COUNT[a].get_unchecked_mut(k) += 1;
			let pm = BIN_MIN[a].as_mut_ptr().add(k);
			st(pm, f32x4_pmin(ld(pm), vlo));
			let px = BIN_MAX[a].as_mut_ptr().add(k);
			st(px, f32x4_pmax(ld(px), vhi));
		}
	}

	let mut best_cost = f64::INFINITY;
	let mut best: Option<(usize, f64, u8)> = None;
	for a in 0..3 {
		if !live[a] {
			continue;
		}
		let (bc, bmn, bmx) = (&BIN_COUNT[a], BIN_MIN[a].as_ptr(), BIN_MAX[a].as_ptr());
		let (lmn, lmx) = (LEFT_MIN.as_mut_ptr(), LEFT_MAX.as_mut_ptr());
		let (rmn, rmx) = (RIGHT_MIN.as_mut_ptr(), RIGHT_MAX.as_mut_ptr());

		// Running boxes: `pmin( bin, run )` is `run < bin ? run : bin`, the scalar prefix's choice.
		LEFT_COUNT[0] = bc[0];
		let (mut m, mut x) = (ld(bmn), ld(bmx));
		st(lmn, m);
		st(lmx, x);
		for k in 1..nb {
			LEFT_COUNT[k] = LEFT_COUNT[k - 1] + bc[k];
			m = f32x4_pmin(ld(bmn.add(k)), m);
			x = f32x4_pmax(ld(bmx.add(k)), x);
			st(lmn.add(k), m);
			st(lmx.add(k), x);
		}
		let last = nb - 1;
		RIGHT_COUNT[last] = bc[last];
		let (mut m, mut x) = (ld(bmn.add(last)), ld(bmx.add(last)));
		st(rmn.add(last), m);
		st(rmx.add(last), x);
		for k in (0..last).rev() {
			RIGHT_COUNT[k] = RIGHT_COUNT[k + 1] + bc[k];
			m = f32x4_pmin(ld(bmn.add(k)), m);
			x = f32x4_pmax(ld(bmx.add(k)), x);
			st(rmn.add(k), m);
			st(rmx.add(k), x);
		}

		let extent = cmax[a] as f64 - cmin[a] as f64;
		for i in 1..nb {
			let (lc, rc) = (LEFT_COUNT[i - 1], RIGHT_COUNT[i]);
			if lc == 0 || rc == 0 {
				continue;
			}
			let l_area = area(ld(lmn.add(i - 1)), ld(lmx.add(i - 1)));
			let r_area = area(ld(rmn.add(i)), ld(rmx.add(i)));
			let cost = cfg.traversal
				+ (l_area / parent) * lc as f64 * cfg.intersection
				+ (r_area / parent) * rc as f64 * cfg.intersection;
			if cost < best_cost && cost < leaf_cost {
				best_cost = cost;
				best = Some((a, cmin[a] as f64 + extent * i as f64 / nb as f64, SAH));
			}
		}
	}

	if best.is_some() { best } else { fallback(start, end) }
}

unsafe fn fallback(start: usize, end: usize) -> Option<(usize, f64, u8)> {
	if CFG.object_median {
		object_median(start, end)
	} else if CFG.spatial_median {
		spatial_median(start, end)
	} else {
		None
	}
}

#[inline(always)]
unsafe fn cv(i: usize, axis: usize) -> f64 {
	r(i).c[axis] as f64
}

unsafe fn object_median(start: usize, end: usize) -> Option<(usize, f64, u8)> {
	let mut best_axis = usize::MAX;
	let mut best_spread = -1.0f64;
	for a in 0..3 {
		let mut mn = f64::INFINITY;
		let mut mx = f64::NEG_INFINITY;
		for i in start..end {
			let v = cv(i, a);
			if v < mn { mn = v; }
			if v > mx { mx = v; }
		}
		let spread = mx - mn;
		if spread > best_spread {
			best_spread = spread;
			best_axis = a;
		}
	}
	if best_axis == usize::MAX || best_spread < 1e-10 {
		return if CFG.spatial_median { spatial_median(start, end) } else { None };
	}

	let k = start + (end - start) / 2;
	quickselect(start, end, k, best_axis);
	let mut pos = cv(k, best_axis);

	let mut degenerate = true;
	for i in k + 1..end {
		if cv(i, best_axis) > pos {
			degenerate = false;
			break;
		}
	}
	if degenerate {
		let mut left_max = f64::NEG_INFINITY;
		for i in start..k {
			let v = cv(i, best_axis);
			if v > left_max { left_max = v; }
		}
		if left_max < pos {
			pos = (left_max + pos) * 0.5;
		} else {
			return if CFG.spatial_median { spatial_median(start, end) } else { None };
		}
	}
	Some((best_axis, pos, OBJECT_MEDIAN))
}

unsafe fn spatial_median(start: usize, end: usize) -> Option<(usize, f64, u8)> {
	let mut best_axis = usize::MAX;
	let mut best_spread = -1.0f64;
	let (mut best_min, mut best_max) = (0.0f64, 0.0f64);
	for a in 0..3 {
		let mut mn = f64::INFINITY;
		let mut mx = f64::NEG_INFINITY;
		for i in start..end {
			let t = r(i);
			if (t.mn[a] as f64) < mn { mn = t.mn[a] as f64; }
			if (t.mx[a] as f64) > mx { mx = t.mx[a] as f64; }
		}
		let spread = mx - mn;
		if spread > best_spread {
			best_spread = spread;
			best_axis = a;
			best_min = mn;
			best_max = mx;
		}
	}
	if best_axis == usize::MAX || best_spread < 1e-12 {
		return None;
	}

	let mut pos = (best_min + best_max) * 0.5;
	let count = end - start;
	let mut left = 0;
	for i in start..end {
		if cv(i, best_axis) <= pos { left += 1; }
	}
	if left == 0 || left == count {
		let k = start + count / 2;
		quickselect(start, end, k, best_axis);
		let median = cv(k, best_axis);
		let mut same = true;
		for i in start..end {
			if cv(i, best_axis) != median {
				same = false;
				break;
			}
		}
		if same {
			return None;
		}
		let mut left_max = f64::NEG_INFINITY;
		for i in start..k {
			let v = cv(i, best_axis);
			if v > left_max { left_max = v; }
		}
		if left_max < median {
			pos = (left_max + median) * 0.5;
		} else {
			let mut right_min = f64::INFINITY;
			for i in k + 1..end {
				let v = cv(i, best_axis);
				if v < right_min { right_min = v; }
			}
			pos = (median + right_min) * 0.5;
		}
	}
	Some((best_axis, pos, SPATIAL_MEDIAN))
}

/// Hoare selection with a median-of-three pivot, swap for swap as `BVHBuilder.quickselect`.
/// Indices stay inside `[start, end)` or the instance traps and the host builds in JavaScript.
unsafe fn quickselect(start: usize, end: usize, k: usize, axis: usize) {
	let at = |i: isize| -> f64 {
		if i < start as isize || i >= end as isize { wasm32::unreachable(); }
		cv(i as usize, axis)
	};
	let swap = |i: isize, j: isize| {
		let t = *r(i as usize);
		*r(i as usize) = *r(j as usize);
		*r(j as usize) = t;
	};
	let k = k as isize;
	let mut lo = start as isize;
	let mut hi = end as isize - 1;
	while lo < hi {
		let mid = ((lo + hi) as usize >> 1) as isize;
		if at(lo) > at(mid) { swap(lo, mid); }
		if at(lo) > at(hi) { swap(lo, hi); }
		if at(mid) > at(hi) { swap(mid, hi); }
		let pivot = at(mid);
		let mut i = lo;
		let mut j = hi;
		while i <= j {
			while at(i) < pivot { i += 1; }
			while at(j) > pivot { j -= 1; }
			if i <= j {
				swap(i, j);
				i += 1;
				j -= 1;
			}
		}
		if j < k { lo = i; }
		if i > k { hi = j; }
	}
}
