import { test, expect } from 'bun:test';
import { launchPaintingBrowser, LINUX_GPU_BACKENDS } from '../studio/browser.js';

// launchPaintingBrowser with a fake launch and probe: which browsers it starts, keeps and closes.
const harness = renderers => {
  const launched = [], closed = [], logs = [];
  const launch = async ({ angle }) => {
    if (renderers[angle ?? 'default'] instanceof Error) throw renderers[angle ?? 'default'];
    const b = { angle: angle ?? 'default', close: async () => { closed.push(b.angle); } };
    launched.push(b.angle);
    return b;
  };
  const probe = async b => {
    const r = renderers[b.angle];
    return r == null ? null : { renderer: r, software: /SwiftShader|llvmpipe/.test(r) };
  };
  return { launched, closed, logs, opts: { launch, probe, log: m => logs.push(m), platform: 'linux', env: {}, port: 1 } };
};
const SOFT = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 16.0.0)), SwiftShader driver)';
const AMD = 'ANGLE (AMD, AMD Radeon RX 7900 XTX (radeonsi navi31 ACO), OpenGL ES 3.2)';

test('Linux tries vulkan, then gl-egl, when the default draws in software', () => {
  expect(LINUX_GPU_BACKENDS).toEqual(['vulkan', 'gl-egl']);
});

test('on Linux, a default that draws in software is replaced by the first backend that reaches the GPU', async () => {
  const h = harness({ default: SOFT, vulkan: AMD, 'gl-egl': AMD });
  const b = await launchPaintingBrowser(h.opts);
  expect(b.angle).toBe('vulkan');
  expect(h.launched).toEqual(['default', 'vulkan']);
  expect(h.closed).toEqual(['default']);
  expect(h.logs).toEqual([expect.stringContaining('--use-angle=vulkan (ANGLE (AMD, AMD Radeon RX 7900 XTX')]);
});

test('a backend that fails to start or still draws in software is closed, and the next one is tried', async () => {
  const h = harness({ default: SOFT, vulkan: new Error('no Vulkan'), 'gl-egl': AMD });
  expect((await launchPaintingBrowser(h.opts)).angle).toBe('gl-egl');
  expect(h.closed).toEqual(['default']);
  const h2 = harness({ default: SOFT, vulkan: SOFT, 'gl-egl': AMD });
  expect((await launchPaintingBrowser(h2.opts)).angle).toBe('gl-egl');
  expect(h2.closed).toEqual(['vulkan', 'default']);
});

// On a machine with no GPU at all, a backend can start with no WebGL: rendererOf answers null, never "a GPU".
test('a backend without WebGL is not taken for one on the GPU', async () => {
  const h = harness({ default: SOFT, vulkan: null, 'gl-egl': null });
  expect((await launchPaintingBrowser(h.opts)).angle).toBe('default');
  expect(h.closed).toEqual(['vulkan', 'gl-egl']);
});

test('with no backend reaching a GPU, the default browser is kept and the others closed', async () => {
  const h = harness({ default: SOFT, vulkan: SOFT, 'gl-egl': null });
  expect((await launchPaintingBrowser(h.opts)).angle).toBe('default');
  expect(h.closed).toEqual(['vulkan', 'gl-egl']);
  expect(h.logs).toEqual([]);
});

test('a default that already reaches the GPU, a backend chosen, or another platform: one launch, nothing else tried', async () => {
  const gpu = harness({ default: AMD });
  expect((await launchPaintingBrowser(gpu.opts)).angle).toBe('default');
  const chosen = harness({ vulkan: AMD });
  expect((await launchPaintingBrowser({ ...chosen.opts, angle: 'vulkan' })).angle).toBe('vulkan');
  const fromEnv = harness({ 'gl-egl': SOFT });
  expect((await launchPaintingBrowser({ ...fromEnv.opts, env: { STUDIO_ANGLE: 'gl-egl' } })).angle).toBe('gl-egl');
  const mac = harness({ metal: SOFT });   // (macOS's own backend, Metal)
  expect((await launchPaintingBrowser({ ...mac.opts, platform: 'darwin' })).angle).toBe('metal');
  for (const h of [gpu, chosen, fromEnv, mac]) { expect(h.launched).toHaveLength(1); expect(h.closed).toEqual([]); }
});
