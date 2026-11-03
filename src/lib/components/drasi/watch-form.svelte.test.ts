import type { WatchSpec } from '@drasi-project/temporal-watch-contracts/v1';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import WatchForm from './watch-form.svelte';

let component: ReturnType<typeof mount> | undefined;
const render = (
  disabled = false,
  once = true,
  onsubmit = vi.fn<(id: string, spec: WatchSpec) => Promise<void>>(),
) => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(WatchForm, {
    target,
    props: {
      queries: [{ id: 'query', revision: '2' }],
      capabilities: { enabled: true, once },
      disabled,
      onsubmit,
    },
  });
  flushSync();
  return target;
};
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('native watch form', () => {
  it('defaults to recurring and ignores existing matches', () => {
    const target = render();
    expect(
      target.querySelector<HTMLSelectElement>('#watch-lifetime')?.value,
    ).toBe('persistent');
    expect(
      target.querySelector<HTMLInputElement>('#watch-include-existing')
        ?.checked,
    ).toBe(false);
    expect(
      target.querySelector<HTMLSelectElement>('#watch-action')?.options.length,
    ).toBe(3);
  });
  it('gates one-shot by backend readiness', () => {
    const target = render(false, false);
    expect(
      target.querySelector<HTMLOptionElement>(
        '#watch-lifetime option[value=once]',
      )?.disabled,
    ).toBe(true);
  });
  it('shows owner controls instead of a retargetable action for one-shot', () => {
    const target = render();
    const select = target.querySelector<HTMLSelectElement>('#watch-lifetime');
    if (!select) throw new Error('Missing lifetime control');
    select.value = 'once';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(target.querySelector('#watch-owner-workflow')).not.toBeNull();
    expect(target.querySelector('#watch-owner-run')).not.toBeNull();
    expect(target.querySelector('#watch-deadline')).not.toBeNull();
    expect(target.querySelector('#watch-action')).toBeNull();
    expect(target.querySelector('#watch-trigger')).toBeNull();
  });
  it('disables mutation controls in write-disabled mode', () => {
    const target = render(true);
    expect(
      target.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled,
    ).toBe(true);
    expect(target.querySelector<HTMLInputElement>('#watch-id')?.disabled).toBe(
      true,
    );
  });
  it('retries the identical submitted one-shot specification after its deadline', async () => {
    const onsubmit = vi
      .fn<(id: string, spec: WatchSpec) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Connection interrupted'))
      .mockResolvedValue(undefined);
    const target = render(false, true, onsubmit);
    const value = (selector: string, value: string, event = 'input') => {
      const field = target.querySelector<HTMLInputElement | HTMLSelectElement>(
        selector,
      );
      if (!field) throw new Error(`Missing ${selector}`);
      field.value = value;
      field.dispatchEvent(new Event(event, { bubbles: true }));
      flushSync();
    };
    const deadline = '2030-01-01T00:01';
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(new Date(deadline).getTime() - 60_000);
    value('#watch-query', 'query', 'change');
    value('#watch-lifetime', 'once', 'change');
    value('#watch-owner-workflow', 'owner');
    value('#watch-owner-run', 'b568681f-8d55-412b-b312-ffca8c7332bb');
    value('#watch-deadline', deadline);
    value('#watch-signal-name', 'matched');
    const form = target.querySelector('form');
    if (!form) throw new Error('Missing watch form');
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(onsubmit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        target.querySelector<HTMLButtonElement>('button[type=submit]')
          ?.disabled,
      ).toBe(false),
    );
    now.mockReturnValue(new Date(deadline).getTime() + 60_000);
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(onsubmit).toHaveBeenCalledTimes(2));
    expect(onsubmit.mock.calls[1][1]).toBe(onsubmit.mock.calls[0][1]);
  });
});
