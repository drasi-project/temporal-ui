import { SourceSpec } from '@drasi-project/temporal-watch-contracts/v1';
import { describe, expect, it, vi } from 'vitest';

import {
  createDrasiClient,
  fetchDrasiCapabilities,
  methodAllowed,
} from './drasi-service';

vi.mock('$lib/utilities/route-for-api', () => ({
  base: () => 'https://gateway.test/console',
}));
vi.mock('$lib/utilities/core-provider', () => ({
  runPreRequest: async (context: unknown) => context,
  runPostResponse: async (response: Response) => response,
}));

const source = {
  namespace: 'team one',
  id: 'events',
  revision: '9007199254740993',
  spec: { temporal: {} },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe('Drasi generated contract client', () => {
  it('uses the canonical API origin/basepath and encodes namespace and resource once', async () => {
    const request = vi.fn().mockResolvedValue(json(source));
    const client = createDrasiClient('team one', request);
    const value = await client.sources.get('events');
    expect(request.mock.calls[0][0].replace(/\?$/, '')).toBe(
      'https://gateway.test/console/api/v1/namespaces/team%20one/drasi/sources/events',
    );
    expect(value.revision).toBe('9007199254740993');
  });

  it('serializes generated oneofs using flattened gateway JSON', async () => {
    const request = vi.fn().mockResolvedValue(json(source));
    await createDrasiClient('team one', request).sources.save('events', {
      kind: { $case: 'temporal', value: {} },
    });
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.spec).toEqual({ temporal: {} });
    expect(body.requestId).toBeTruthy();
    expect(SourceSpec.fromJSON(body.spec).kind?.$case).toBe('temporal');
  });

  it('retains the request identity and expected revision after ambiguous failures', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(json(source));
    const client = createDrasiClient('team one', request);
    await expect(
      client.sources.operation('events', '17', 'stop'),
    ).rejects.toThrow('connection lost');
    await client.sources.operation('events', '17', 'stop');
    const first = JSON.parse(request.mock.calls[0][1].body);
    const retry = JSON.parse(request.mock.calls[1][1].body);
    expect(first.requestId).toBe(retry.requestId);
    expect(first.expectedRevision).toBe('17');
  });

  it('sends delete revision and request identity as query parameters', async () => {
    const request = vi.fn().mockResolvedValue(json(source));
    await createDrasiClient('team one', request).sources.operation(
      'events',
      '17',
      'delete',
    );
    const url = new URL(request.mock.calls[0][0]);
    expect(url.searchParams.get('expectedRevision')).toBe('17');
    expect(url.searchParams.get('requestId')).toBeTruthy();
    expect(request.mock.calls[0][1].method).toBe('DELETE');
  });

  it('retains mutation identity when a successful HTTP response violates the resource contract', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json(source));
    const client = createDrasiClient('team one', request);
    await expect(
      client.sources.operation('events', '17', 'stop'),
    ).rejects.toThrow();
    await client.sources.operation('events', '17', 'stop');
    expect(JSON.parse(request.mock.calls[0][1].body).requestId).toBe(
      JSON.parse(request.mock.calls[1][1].body).requestId,
    );
  });

  it('surfaces forbidden/invalid responses instead of returning empty success', async () => {
    const request = vi.fn().mockResolvedValue(json({ message: 'denied' }, 403));
    await expect(
      createDrasiClient('team one', request).listSources(),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      createDrasiClient(
        'team one',
        vi.fn().mockResolvedValue(json({})),
      ).sources.get('events'),
    ).rejects.toThrow();
  });

  it('enforces advertised request size before transmission', async () => {
    const request = vi.fn();
    await expect(
      createDrasiClient('team one', request, 8).sources.save('events', {
        kind: { $case: 'temporal', value: {} },
      }),
    ).rejects.toThrow('request-size limit');
    expect(request).not.toHaveBeenCalled();
  });

  it('fetches authoritative plugin details without changing the advertised digest', async () => {
    const plugin = {
      catalogId: 'trusted catalog',
      id: 'source',
      version: '1.0',
      digest: 'sha256:pinned',
    };
    const request = vi.fn().mockResolvedValue(json(plugin));
    const client = createDrasiClient(undefined, request);
    expect((await client.plugin(plugin)).digest).toBe(plugin.digest);
    expect(request.mock.calls[0][0].replace(/\?$/, '')).toBe(
      'https://gateway.test/console/api/v1/drasi/plugins/catalogs/trusted%20catalog/plugins/source/versions/1.0',
    );
    request.mockResolvedValue(json({ ...plugin, digest: 'sha256:changed' }));
    await expect(client.plugin(plugin)).rejects.toThrow('digest changed');
  });

  it('distinguishes unsupported capability routes from auth failures', async () => {
    expect(
      await fetchDrasiCapabilities(() => Promise.reject({ statusCode: 404 })),
    ).toEqual({ kind: 'unsupported' });
    expect(
      await fetchDrasiCapabilities(() =>
        Promise.reject({ statusCode: 403, message: 'denied' }),
      ),
    ).toEqual({ kind: 'error', message: 'denied' });
  });

  it('gates operations by exact caller-filtered methods, not descriptor presence', () => {
    const capabilities = {
      enabled: true,
      allowedMethods: ['/drasi.watch.v1.PluginService/ListPlugins'],
    };
    expect(methodAllowed(capabilities, 'PluginService', 'ListPlugins')).toBe(
      true,
    );
    expect(methodAllowed(capabilities, 'PluginService', 'InstallPlugin')).toBe(
      false,
    );
    expect(
      methodAllowed(
        { ...capabilities, enabled: false },
        'PluginService',
        'ListPlugins',
      ),
    ).toBe(false);
  });
});
