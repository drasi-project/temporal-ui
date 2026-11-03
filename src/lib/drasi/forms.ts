import {
  InitialResults,
  ResultPayload,
  Trigger,
  type WatchSpec,
  WorkflowAction,
} from '@drasi-project/temporal-watch-contracts/v1';
import { z } from 'zod';

export const resourceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const revisionSchema = z.string().regex(/^[1-9]\d*$/);
export type WatchDraft = {
  queryId: string;
  queryRevision: string;
  trigger: Trigger;
  includeExisting: boolean;
  once: boolean;
  ownerWorkflowId: string;
  ownerRunId: string;
  deadline: string;
  operation: 'start' | 'signal' | 'signalWithStart';
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue: string;
  signalName: string;
  input: string;
  omitResult: boolean;
};

export const emptyWatchDraft = (): WatchDraft => ({
  queryId: '',
  queryRevision: '',
  trigger: Trigger.TRIGGER_ENTER,
  includeExisting: false,
  once: false,
  ownerWorkflowId: '',
  ownerRunId: '',
  deadline: '',
  operation: 'start',
  workflowId: '',
  runId: '',
  workflowType: '',
  taskQueue: '',
  signalName: '',
  input: '[]',
  omitResult: false,
});

const required = z.string().min(1);
const uuid = z.uuid();

export const buildWatchSpec = (draft: WatchDraft): WatchSpec => {
  resourceIdSchema.parse(draft.queryId);
  revisionSchema.parse(draft.queryRevision);
  const input = z.array(z.json()).parse(JSON.parse(draft.input));
  const payloads = {
    payloads: input.map((value) => ({
      metadata: { encoding: new TextEncoder().encode('json/plain') },
      data: new TextEncoder().encode(JSON.stringify(value)),
    })),
  };
  const start = () => ({
    workflowId: required.parse(draft.workflowId),
    workflowType: required.parse(draft.workflowType),
    taskQueue: required.parse(draft.taskQueue),
    input: payloads,
  });
  let action: WorkflowAction;
  if (draft.once) {
    required.parse(draft.ownerWorkflowId);
    uuid.parse(draft.ownerRunId);
    const deadline = new Date(draft.deadline);
    if (
      !Number.isFinite(deadline.getTime()) ||
      deadline.getTime() <= Date.now()
    ) {
      throw new Error('A one-shot watch requires a future deadline.');
    }
    action = {
      operation: {
        $case: 'signal',
        value: {
          target: {
            $case: 'run',
            value: {
              workflowId: draft.ownerWorkflowId,
              runId: draft.ownerRunId,
            },
          },
          signalName: required.parse(draft.signalName),
          input: payloads,
        },
      },
    };
  } else if (draft.operation === 'start') {
    action = { operation: { $case: 'start', value: start() } };
  } else if (draft.operation === 'signalWithStart') {
    action = {
      operation: {
        $case: 'signalWithStart',
        value: {
          start: start(),
          signalName: required.parse(draft.signalName),
          signalInput: payloads,
        },
      },
    };
  } else {
    action = {
      operation: {
        $case: 'signal',
        value: {
          target: draft.runId
            ? {
                $case: 'run',
                value: {
                  workflowId: required.parse(draft.workflowId),
                  runId: uuid.parse(draft.runId),
                },
              }
            : {
                $case: 'currentWorkflowId',
                value: required.parse(draft.workflowId),
              },
          signalName: required.parse(draft.signalName),
          input: payloads,
        },
      },
    };
  }
  action.resultPayload = draft.omitResult
    ? ResultPayload.RESULT_PAYLOAD_OMIT
    : ResultPayload.RESULT_PAYLOAD_APPEND;
  return {
    query: { id: draft.queryId, revision: draft.queryRevision },
    trigger: draft.once ? Trigger.TRIGGER_ENTER : draft.trigger,
    initialResults: draft.includeExisting
      ? InitialResults.INITIAL_RESULTS_INCLUDE
      : InitialResults.INITIAL_RESULTS_IGNORE,
    lifetime: draft.once
      ? {
          $case: 'once',
          value: {
            owner: {
              workflowId: draft.ownerWorkflowId,
              runId: draft.ownerRunId,
            },
            deadline: new Date(draft.deadline).toISOString(),
          },
        }
      : { $case: 'persistent', value: {} },
    action,
  };
};
