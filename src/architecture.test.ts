import { describe, it } from '@paulmillr/jsbt/test.js';
import { deepEqual, equal, ok } from 'node:assert/strict';
import * as sp from 'node:path';

import {
  attachSharedSubscriber,
  createSharedResourceState,
  detachSharedSubscriber,
  invalidateSharedResource,
  selectBackend,
} from './backend.js';
import type { BackendResourceKey } from './runtime.js';
import { isSameOrInside, isStrictlyInside, normalizePath, WatchHelper } from './runtime.js';
import { LifecycleScope, resolveRecursiveCandidate } from './tree.js';

export function registerArchitectureTests(reportTestFailure: (error: unknown) => never): void {
  describe('architecture boundaries', () => {
    it('owns tasks and subscriptions in one lifecycle scope', async () => {
      let settled = 0;
      let closed = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const scope = new LifecycleScope(() => {
        settled += 1;
      }, reportTestFailure);
      scope.track(barrier);
      scope.addCloser('/owned', () => {
        closed += 1;
      });

      equal(scope.tasks.size, 1);
      equal(scope.closers.size, 1);
      await Promise.allSettled(scope.beginClose());
      equal(scope.state, 'CLOSING');
      equal(scope.abortController.signal.aborted, true);
      equal(closed, 1);
      equal(scope.closers.size, 0);

      release();
      await scope.drain();
      scope.finishClose();
      equal(settled, 1);
      equal(scope.state, 'CLOSED');
    });

    it('rejects reconciliation candidates that escape their root', () => {
      const root = sp.resolve('/watch-root');
      const candidate = sp.join(root, 'child.txt');
      equal(resolveRecursiveCandidate(root, '../escape.txt'), undefined);
      equal(resolveRecursiveCandidate(root, 'child.txt'), candidate);
    });

    it('keeps containment checks segment-aware', () => {
      const root = sp.resolve('/watch-root');
      equal(isSameOrInside(root, root), true);
      equal(isStrictlyInside(root, root), false);
      equal(isStrictlyInside(root, sp.join(root, 'child')), true);
      equal(isSameOrInside(root, sp.resolve('/watch-root-sibling')), false);
    });

    it('normalizes separators while preserving UNC roots', () => {
      equal(normalizePath('folder\\child\\..\\file.txt'), 'folder/file.txt');
      equal(normalizePath('//server/share/folder'), '//server/share/folder');
    });

    it('keeps native observations local while preserving traversal state', () => {
      const helper = new WatchHelper('/watch-root', true, {
        capturePathGeneration: () => 7,
        isntIgnored: () => true,
      });
      helper.realpathAncestry.add('/real-root');
      const trigger = {
        kind: 'native' as const,
        resource: sp.resolve('/watch-root') as BackendResourceKey,
        rawEvent: 'rename' as const,
        relativePath: 'child.txt',
        sequence: 1,
        observedAt: 10,
      };

      const observation = helper.withObservation(trigger);
      const child = observation.fork('/watch-root/child');
      equal(helper.observationTrigger, undefined);
      equal(observation.observationTrigger, trigger);
      equal(observation.realpathAncestry, helper.realpathAncestry);
      equal(child.observationTrigger, trigger);
      equal(child.realpathAncestry === helper.realpathAncestry, false);
      equal(child.realpathAncestry.has('/real-root'), true);
      equal(child.pathGeneration, 7);
    });

    it('selects one immutable backend capability set', () => {
      deepEqual(selectBackend({ backend: 'polling' }), {
        kind: 'polling',
        polling: true,
        recursive: false,
        perDirectory: false,
      });
      deepEqual(selectBackend({ backend: 'native-recursive', depth: 1 }), {
        kind: 'native-per-directory',
        polling: false,
        recursive: false,
        perDirectory: true,
      });
      equal(Object.isFrozen(selectBackend({ backend: 'native-recursive' })), true);
    });

    it('owns shared resource generations and subscriber teardown once', () => {
      const key = sp.resolve('/resource') as BackendResourceKey;
      const resource = createSharedResourceState<string>(key, ['first']);
      const successor = createSharedResourceState<string>(key);
      ok(successor.generation > resource.generation);
      let reconfigured = 0;
      let closed = 0;

      equal(attachSharedSubscriber(resource, 'second'), true);
      reconfigured += 1;
      equal(detachSharedSubscriber(resource, 'first'), 'remaining');
      reconfigured += 1;
      equal(reconfigured, 2);
      equal(closed, 0);
      deepEqual(invalidateSharedResource(resource), ['second']);
      closed += 1;
      equal(invalidateSharedResource(resource), undefined);
      equal(closed, 1);
    });
  });
}
