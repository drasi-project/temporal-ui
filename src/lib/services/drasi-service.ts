import * as contract from '@drasi-project/temporal-watch-contracts/v1';
import { z } from 'zod';

import { requestFromAPI } from '$lib/utilities/request-from-api';
import { base } from '$lib/utilities/route-for-api';

type Codec<T> = {
  fromJSON: (value: unknown) => T;
  toJSON: (value: T) => unknown;
};

export type CapabilityState<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  const parsed = z.object({ message: z.string() }).safeParse(error);
  return parsed.success ? parsed.data.message : String(error);
};

export const methodAllowed = (
  capabilities: contract.Capabilities | contract.PluginCapabilities | undefined,
  service: 'WatchService' | 'PluginService',
  method: string,
): boolean =>
  capabilities?.enabled === true &&
  capabilities.allowedMethods?.includes(
    `/drasi.watch.v1.${service}/${method}`,
  ) === true;

const objectSchema = z.record(z.string(), z.unknown());
const resourceSchema = z.object({
  id: z.string().min(1),
  revision: z.string().regex(/^[1-9]\d*$/),
});

export const createDrasiClient = (
  namespace?: string,
  request = fetch,
  maxRequestBytes = 1 << 20,
) => {
  const prefix =
    namespace === undefined
      ? '/api/v1/drasi/plugins'
      : `/api/v1/namespaces/${encodeURIComponent(namespace)}/drasi`;
  const pending = new Map<string, string>();

  const call = async <T>(
    path: string,
    codec: Codec<T>,
    method = 'GET',
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<T> => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).length >
        Math.min(maxRequestBytes, 1 << 20)
    ) {
      throw new Error('Request exceeds the server request-size limit.');
    }
    const response = await requestFromAPI<unknown>(
      `${base(namespace)}${prefix}${path}`,
      {
        request,
        notifyOnError: false,
        params,
        options: {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: serialized,
        },
      },
    );
    return codec.fromJSON(objectSchema.parse(response));
  };

  const mutate = async <T>(
    path: string,
    codec: Codec<T>,
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> => {
    const key = JSON.stringify([path, method, body]);
    const requestId = pending.get(key) ?? crypto.randomUUID();
    pending.set(key, requestId);
    const value =
      method === 'DELETE'
        ? await call(path, codec, method, undefined, {
            expectedRevision: String(body.expectedRevision),
            requestId,
          })
        : await call(path, codec, method, { ...body, requestId });
    pending.delete(key);
    return value;
  };

  const resource = <R, S>(
    collection: string,
    codec: Codec<R>,
    specCodec: Codec<S>,
  ) => {
    const checked: Codec<R> = {
      toJSON: codec.toJSON,
      fromJSON: (body) => {
        const value = codec.fromJSON(body);
        resourceSchema.parse(value);
        return value;
      },
    };
    return {
      get: async (id: string) => {
        const value = await call(
          `/${collection}/${encodeURIComponent(id)}`,
          checked,
        );
        return value;
      },
      save: async (id: string, spec: S, revision?: string) => {
        const value = await mutate(
          `/${collection}${revision ? `/${encodeURIComponent(id)}` : ''}`,
          checked,
          revision ? 'PUT' : 'POST',
          {
            namespace,
            id,
            spec: specCodec.toJSON(spec),
            ...(revision ? { expectedRevision: revision } : {}),
          },
        );
        return value;
      },
      operation: async (
        id: string,
        revision: string,
        operation: string,
        extra: Record<string, unknown> = {},
      ) => {
        const value = await mutate(
          `/${collection}/${encodeURIComponent(id)}${operation === 'delete' ? '' : `/${operation}`}`,
          checked,
          operation === 'delete' ? 'DELETE' : 'POST',
          { namespace, id, expectedRevision: revision, ...extra },
        );
        return value;
      },
    };
  };

  return {
    capabilities: () => call('/capabilities', contract.Capabilities),
    pluginCapabilities: () =>
      call('/capabilities', contract.PluginCapabilities),
    sources: resource('sources', contract.Source, contract.SourceSpec),
    queries: resource('queries', contract.Query, contract.QuerySpec),
    watches: resource('watches', contract.Watch, contract.WatchSpec),
    listSources: (pageToken = '') =>
      call('/sources', contract.ListSourcesResponse, 'GET', undefined, {
        pageSize: '50',
        pageToken,
      }),
    listQueries: (pageToken = '') =>
      call('/queries', contract.ListQueriesResponse, 'GET', undefined, {
        pageSize: '50',
        pageToken,
      }),
    listWatches: (pageToken = '') =>
      call('/watches', contract.ListWatchesResponse, 'GET', undefined, {
        pageSize: '50',
        pageToken,
      }),
    validateQuery: (spec: contract.QuerySpec) =>
      call(
        '/queries/validate',
        contract.ValidateQueryResponse,
        'POST',
        contract.ValidateQueryRequest.toJSON({ namespace, spec }),
      ),
    previewQuery: (spec: contract.QuerySpec, limit: number) =>
      call(
        '/queries/preview',
        contract.PreviewQueryResponse,
        'POST',
        contract.PreviewQueryRequest.toJSON({ namespace, spec, limit }),
      ),
    deliveries: (id: string, pageToken = '') =>
      call(
        `/watches/${encodeURIComponent(id)}/deliveries`,
        contract.ListDeliveriesResponse,
        'GET',
        undefined,
        { pageSize: '50', pageToken },
      ),
    retryDelivery: (
      id: string,
      revision: string,
      actionId: string,
      acknowledgeAmbiguous: boolean,
    ) =>
      mutate(
        `/watches/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(actionId)}/retry`,
        contract.Delivery,
        'POST',
        {
          namespace,
          id,
          expectedRevision: revision,
          actionId,
          acknowledgeAmbiguous,
        },
      ),
    catalogs: (pageToken = '') =>
      call('/catalogs', contract.ListCatalogsResponse, 'GET', undefined, {
        pageSize: '50',
        pageToken,
      }),
    plugins: (search = '', catalogId = '', pageToken = '') =>
      call('', contract.ListPluginsResponse, 'GET', undefined, {
        search,
        catalogId,
        pageSize: '50',
        pageToken,
      }),
    plugin: async (plugin: contract.Plugin) => {
      const ref = z
        .object({
          catalogId: z.string().min(1),
          id: z.string().min(1),
          version: z.string().min(1),
        })
        .parse(plugin);
      const result = await call(
        `/catalogs/${encodeURIComponent(ref.catalogId)}/plugins/${encodeURIComponent(ref.id)}/versions/${encodeURIComponent(ref.version)}`,
        contract.Plugin,
      );
      if (plugin.digest && result.digest !== plugin.digest) {
        throw new Error(
          'Plugin digest changed. Search again before using its metadata.',
        );
      }
      return result;
    },
    installations: (pageToken = '') =>
      call(
        '/installations',
        contract.ListInstallationsResponse,
        'GET',
        undefined,
        { pageSize: '50', pageToken },
      ),
    installation: (digest: string) =>
      call(
        `/installations/${encodeURIComponent(digest)}`,
        contract.PluginInstallation,
      ),
    install: (plugin: contract.Plugin) =>
      mutate('/installations', contract.PluginInstallation, 'POST', {
        catalogId: plugin.catalogId,
        pluginId: plugin.id,
        version: plugin.version,
        digest: plugin.digest,
      }),
    load: (digest: string) =>
      mutate(
        `/installations/${encodeURIComponent(digest)}/load`,
        contract.PluginInstallation,
        'POST',
        { digest },
      ),
  };
};

export const fetchDrasiCapabilities = async <T>(
  load: () => Promise<T>,
): Promise<CapabilityState<T>> => {
  try {
    return { kind: 'ready', value: await load() };
  } catch (error) {
    const status = z.object({ statusCode: z.number() }).safeParse(error);
    if (status.success && [404, 501].includes(status.data.statusCode)) {
      return { kind: 'unsupported' };
    }
    return { kind: 'error', message: errorMessage(error) };
  }
};
