import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {INBOX_RENDER_LIMIT, RenderScheduler, inboxPage} from '../src/surface/view';

function entries(n: number): number[] {
	return Array.from({length: n}, (_, i) => i);
}

describe('inboxPage', () => {
	it('renders everything when the inbox is under the cap', () => {
		const page = inboxPage(entries(10), false);
		expect(page.shown).toHaveLength(10);
		expect(page.hidden).toBe(0);
	});

	it('renders everything when exactly at the cap', () => {
		const page = inboxPage(entries(INBOX_RENDER_LIMIT), false);
		expect(page.shown).toHaveLength(INBOX_RENDER_LIMIT);
		expect(page.hidden).toBe(0);
	});

	// A full server-side inbox is INBOX_MAX (200) entries; rendering all of
	// them as Markdown on every repaint is what made the view crawl.
	it('caps a full inbox and reports the remainder', () => {
		const page = inboxPage(entries(200), false);
		expect(page.shown).toHaveLength(INBOX_RENDER_LIMIT);
		expect(page.hidden).toBe(200 - INBOX_RENDER_LIMIT);
	});

	it('keeps the newest entries, which come first', () => {
		const page = inboxPage(entries(200), false, 3);
		expect(page.shown).toEqual([0, 1, 2]);
	});

	it('renders everything once the user asks for the rest', () => {
		const page = inboxPage(entries(200), true);
		expect(page.shown).toHaveLength(200);
		expect(page.hidden).toBe(0);
	});

	it('does not mutate the input', () => {
		const input = entries(200);
		inboxPage(input, false);
		expect(input).toHaveLength(200);
	});

	it('handles an empty inbox', () => {
		expect(inboxPage([], false)).toEqual({shown: [], hidden: 0});
	});
});

describe('RenderScheduler', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not run synchronously', () => {
		const run = vi.fn();
		new RenderScheduler(50, run).schedule();
		expect(run).not.toHaveBeenCalled();
	});

	it('runs once the delay elapses', () => {
		const run = vi.fn();
		new RenderScheduler(50, run).schedule();
		vi.advanceTimersByTime(50);
		expect(run).toHaveBeenCalledTimes(1);
	});

	// The whole point: draining a 100-envelope backlog must cost one paint.
	it('collapses a burst of requests into a single run', () => {
		const run = vi.fn();
		const scheduler = new RenderScheduler(50, run);
		for (let i = 0; i < 100; i++) {
			scheduler.schedule();
		}
		vi.advanceTimersByTime(50);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('schedules again after firing', () => {
		const run = vi.fn();
		const scheduler = new RenderScheduler(50, run);
		scheduler.schedule();
		vi.advanceTimersByTime(50);
		scheduler.schedule();
		vi.advanceTimersByTime(50);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it('bounds the wait, so a steady stream still paints', () => {
		const run = vi.fn();
		const scheduler = new RenderScheduler(50, run);
		// A request every 10ms must not defer the paint indefinitely.
		for (let i = 0; i < 20; i++) {
			scheduler.schedule();
			vi.advanceTimersByTime(10);
		}
		expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it('cancel stops a pending run', () => {
		const run = vi.fn();
		const scheduler = new RenderScheduler(50, run);
		scheduler.schedule();
		scheduler.cancel();
		vi.advanceTimersByTime(1000);
		expect(run).not.toHaveBeenCalled();
	});

	it('cancel is safe with nothing pending', () => {
		const scheduler = new RenderScheduler(50, vi.fn());
		expect(() => scheduler.cancel()).not.toThrow();
	});

	it('can be reused after a cancel', () => {
		const run = vi.fn();
		const scheduler = new RenderScheduler(50, run);
		scheduler.schedule();
		scheduler.cancel();
		scheduler.schedule();
		vi.advanceTimersByTime(50);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('reports whether a run is pending', () => {
		const scheduler = new RenderScheduler(50, vi.fn());
		expect(scheduler.pending).toBe(false);
		scheduler.schedule();
		expect(scheduler.pending).toBe(true);
		vi.advanceTimersByTime(50);
		expect(scheduler.pending).toBe(false);
	});
});
