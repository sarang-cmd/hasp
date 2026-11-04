export const defaults = Object.freeze({ design: 'foundry', modes: { foundry: 'light', nightshift: 'dark' } });

export function normalizeAppearance(value) {
  const validMode = (mode, fallback) => ['light', 'dark'].includes(mode) ? mode : fallback;
  return {
    design: ['foundry', 'nightshift'].includes(value?.design) ? value.design : defaults.design,
    modes: {
      foundry: validMode(value?.modes?.foundry, defaults.modes.foundry),
      nightshift: validMode(value?.modes?.nightshift, defaults.modes.nightshift)
    }
  };
}
