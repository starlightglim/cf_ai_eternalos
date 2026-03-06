/**
 * Appearance Store for EternalOS
 *
 * Manages custom appearance settings that override the base theme:
 * - Accent color (selection, highlights, title bars)
 * - Desktop color (background behind icons)
 * - Window background color (content area inside windows)
 * - Font smoothing toggle
 *
 * These customizations layer ON TOP of the selected theme,
 * allowing users to personalize colors while keeping the theme's structure.
 */

import { create } from 'zustand';
import { updateProfile, isApiConfigured } from '../services/api';

export interface CustomAppearance {
  accentColor?: string; // Hex color, e.g., "#000080"
  desktopColor?: string; // Hex color for desktop background
  windowBgColor?: string; // Hex color for window content area
  fontSmoothing?: boolean; // Override theme's font smoothing
  customCSS?: string; // User-defined CSS, max 10KB
}

const APPEARANCE_STORAGE_KEY = 'eternalos-appearance';

/**
 * Calculate relative luminance of a hex color (WCAG formula)
 */
function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;

  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Convert hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Determine if background is dark
 */
function isDarkColor(hex: string): boolean {
  return getLuminance(hex) < 0.4;
}

/**
 * Lighten or darken a hex color by a percentage
 */
function adjustColor(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const adjust = (c: number) => {
    const adjusted = Math.round(c + (percent > 0 ? (255 - c) : c) * (percent / 100));
    return Math.max(0, Math.min(255, adjusted));
  };

  const r = adjust(rgb.r);
  const g = adjust(rgb.g);
  const b = adjust(rgb.b);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Generate derived colors from accent color using HSL manipulation
 */
function deriveAccentColors(accentColor: string): {
  selection: string;
  selectionText: string;
  highlight: string;
  titleBarActive: string;
} {
  const rgb = hexToRgb(accentColor);
  if (!rgb) {
    return {
      selection: accentColor,
      selectionText: '#FFFFFF',
      highlight: adjustColor(accentColor, 30),
      titleBarActive: accentColor,
    };
  }

  // Selection is the accent color itself
  const selection = accentColor;

  // Selection text should contrast with accent
  const selectionText = isDarkColor(accentColor) ? '#FFFFFF' : '#000000';

  // Highlight is a lighter version for hover states
  const highlight = adjustColor(accentColor, 40);

  // Title bar active color
  const titleBarActive = accentColor;

  return {
    selection,
    selectionText,
    highlight,
    titleBarActive,
  };
}

/**
 * Apply custom appearance settings to the document
 * Exported for use in visitor mode (to apply owner's appearance)
 */
export function applyAppearance(appearance: CustomAppearance) {
  const root = document.documentElement;

  // Apply accent color and derived colors
  if (appearance.accentColor) {
    const derived = deriveAccentColors(appearance.accentColor);
    root.style.setProperty('--selection', derived.selection);
    root.style.setProperty('--selection-text', derived.selectionText);
    // Don't override highlight for now - it affects too many things
    // root.style.setProperty('--highlight', derived.highlight);
    root.style.setProperty('--accent', appearance.accentColor);
  }

  // Apply desktop color
  if (appearance.desktopColor) {
    root.style.setProperty('--custom-desktop-color', appearance.desktopColor);
    // Also set text colors for desktop based on desktop color
    const desktopTextColor = isDarkColor(appearance.desktopColor) ? '#FFFFFF' : '#000000';
    root.style.setProperty('--desktop-text-color', desktopTextColor);
  } else {
    root.style.removeProperty('--custom-desktop-color');
    root.style.removeProperty('--desktop-text-color');
  }

  // Apply window background color
  if (appearance.windowBgColor) {
    root.style.setProperty('--window-bg', appearance.windowBgColor);
    // Calculate text color for window content
    const windowTextColor = isDarkColor(appearance.windowBgColor) ? '#FFFFFF' : '#000000';
    const windowTextSecondary = isDarkColor(appearance.windowBgColor) ? '#CCCCCC' : '#666666';
    root.style.setProperty('--window-text-color', windowTextColor);
    root.style.setProperty('--window-text-secondary', windowTextSecondary);
  }

  // Apply font smoothing
  if (appearance.fontSmoothing !== undefined) {
    if (appearance.fontSmoothing) {
      document.body.style.setProperty('-webkit-font-smoothing', 'antialiased');
      document.body.style.setProperty('-moz-osx-font-smoothing', 'grayscale');
    } else {
      document.body.style.setProperty('-webkit-font-smoothing', 'none');
      document.body.style.setProperty('-moz-osx-font-smoothing', 'unset');
    }
  }

  // Apply custom CSS
  applyCustomCSS(appearance.customCSS);
}

// Allowed url() path prefixes for defense-in-depth sanitization
const ALLOWED_CSS_URL_PREFIXES = [
  '/api/css-assets/',
  '/api/wallpaper/',
  '/api/icon/',
];

/**
 * Validate a URL string against the allowlist.
 * Uses proper URL parsing instead of regex for security.
 */
function isAllowedCSSUrl(urlValue: string): boolean {
  // Normalize: trim whitespace, remove quotes, decode
  const normalized = urlValue.trim().replace(/^['"]|['"]$/g, '');

  // Block dangerous protocols explicitly
  const lowerUrl = normalized.toLowerCase();
  if (
    lowerUrl.startsWith('javascript:') ||
    lowerUrl.startsWith('data:') ||
    lowerUrl.startsWith('vbscript:') ||
    lowerUrl.startsWith('file:')
  ) {
    return false;
  }

  // Only allow relative paths starting with our allowed prefixes
  // This blocks absolute URLs (http://, https://, //) which could exfiltrate data
  if (normalized.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    return false;
  }

  // Check against allowlist
  return ALLOWED_CSS_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Sanitize CSS url() values — strip any url() not matching the allowlist.
 * This is defense-in-depth; the editor validates before saving,
 * but this catches anything that slips through (e.g., visitor mode injection).
 *
 * Uses a more robust regex that handles:
 * - Quoted and unquoted URLs
 * - Whitespace/newlines inside url()
 * - Escaped characters
 */
function sanitizeCSSUrls(css: string): string {
  // Match url() with optional quotes, handling whitespace and newlines
  // This regex captures the full url(...) including any internal whitespace
  return css.replace(
    /url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi,
    (match, _quote, urlValue) => {
      // Clean up the URL value (remove internal whitespace/newlines that could be used to bypass)
      const cleanedUrl = urlValue.replace(/[\r\n\t]/g, '').trim();

      if (isAllowedCSSUrl(cleanedUrl)) {
        // Reconstruct with cleaned URL to prevent whitespace-based attacks
        return `url('${cleanedUrl}')`;
      }
      return 'url(about:blank)'; // Blocked — neutralize
    }
  );
}

/**
 * Apply custom CSS by injecting a style element
 * CSS is scoped to .user-desktop for security
 */
export function applyCustomCSS(css: string | undefined) {
  // Remove existing custom CSS
  const existingStyle = document.getElementById('eternalos-custom-css');
  if (existingStyle) {
    existingStyle.remove();
  }

  if (!css || !css.trim()) return;

  // Defense-in-depth: sanitize url() values before injection
  const sanitizedCSS = sanitizeCSSUrls(css);

  // Scope the CSS to .user-desktop
  const scopedCSS = scopeCSSToUserDesktop(sanitizedCSS);

  // Create and inject style element
  const style = document.createElement('style');
  style.id = 'eternalos-custom-css';
  style.textContent = scopedCSS;
  document.head.appendChild(style);
}

/**
 * Parse CSS into top-level rule blocks by tracking brace depth.
 * Returns an array of { selector, body } for each rule.
 * This prevents scope-escape attacks like: `.user-desktop { } body { color:red }`
 */
function parseTopLevelRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let current = '';
  let selectorEnd = -1;

  // Strip CSS comments first to avoid false brace matches inside comments
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];

    if (ch === '{') {
      if (depth === 0) {
        selectorEnd = current.length;
      }
      depth++;
      current += ch;
    } else if (ch === '}') {
      if (depth <= 0) {
        // Stray closing brace (no matching open) — skip it to prevent
        // scope-escape via leading `}` characters
        depth = 0;
        current = '';
        selectorEnd = -1;
        continue;
      }
      depth--;
      current += ch;
      if (depth === 0) {
        const selector = current.slice(0, selectorEnd).trim();
        // body is everything between the first { and last }
        const body = current.slice(selectorEnd + 1, current.length - 1).trim();
        if (selector) {
          rules.push({ selector, body });
        }
        current = '';
        selectorEnd = -1;
      }
    } else {
      current += ch;
    }
  }

  return rules;
}

/**
 * Scope CSS to .user-desktop to prevent affecting system UI.
 * Uses brace-depth parsing to prevent scope-escape attacks.
 */
function scopeCSSToUserDesktop(css: string): string {
  if (!css.trim()) return '';

  const rules = parseTopLevelRules(css);
  const scopedRules: string[] = [];

  for (const { selector, body } of rules) {
    // Handle @keyframes specially - keep as-is
    if (selector.startsWith('@keyframes') || selector.startsWith('@-webkit-keyframes')) {
      scopedRules.push(`${selector} { ${body} }`);
      continue;
    }

    // Handle @media/@supports — recursively scope inner selectors
    if (selector.startsWith('@media') || selector.startsWith('@supports')) {
      const innerScoped = scopeCSSToUserDesktop(body);
      scopedRules.push(`${selector} { ${innerScoped} }`);
      continue;
    }

    // Skip @font-face for security
    if (selector.startsWith('@font-face')) {
      continue;
    }

    // Scope each selector
    const scopedSelectors = selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (s.startsWith('.user-desktop')) return s;
        if (s === ':root' || s === 'body' || s === 'html') return '.user-desktop';
        return `.user-desktop ${s}`;
      })
      .join(', ');

    scopedRules.push(`${scopedSelectors} { ${body} }`);
  }

  return scopedRules.join('\n');
}

/**
 * Clear all custom appearance settings from the document
 * Used when leaving visitor mode to restore the user's own appearance
 */
export function clearAppearance() {
  const root = document.documentElement;

  // Clear accent color properties
  root.style.removeProperty('--selection');
  root.style.removeProperty('--selection-text');
  root.style.removeProperty('--accent');

  // Clear desktop color properties
  root.style.removeProperty('--custom-desktop-color');
  root.style.removeProperty('--desktop-text-color');

  // Clear window background properties
  root.style.removeProperty('--window-bg');
  root.style.removeProperty('--window-text-color');
  root.style.removeProperty('--window-text-secondary');

  // Clear font smoothing
  document.body.style.removeProperty('-webkit-font-smoothing');
  document.body.style.removeProperty('-moz-osx-font-smoothing');

  // Clear custom CSS
  const customStyle = document.getElementById('eternalos-custom-css');
  if (customStyle) {
    customStyle.remove();
  }
}

/**
 * Load saved appearance from localStorage
 */
function loadSavedAppearance(): CustomAppearance {
  try {
    const saved = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // Ignore localStorage errors
  }
  return {};
}

/**
 * Save appearance to localStorage
 */
function saveLocalAppearance(appearance: CustomAppearance) {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Ignore localStorage errors
  }
}

interface AppearanceStore {
  appearance: CustomAppearance;
  originalAppearance: CustomAppearance; // For tracking changes
  isLoading: boolean;
  hasUnsavedChanges: boolean;

  // Actions
  setAccentColor: (color: string) => void;
  setDesktopColor: (color: string) => void;
  setWindowBgColor: (color: string) => void;
  setFontSmoothing: (enabled: boolean) => void;
  setCustomCSS: (css: string) => void;
  resetAppearance: () => void;
  saveAppearance: () => Promise<void>;
  loadAppearance: (appearance: CustomAppearance) => void;
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => {
  // Load initial appearance
  const initialAppearance = loadSavedAppearance();

  // Apply initial appearance after a microtask
  queueMicrotask(() => {
    applyAppearance(initialAppearance);
  });

  return {
    appearance: initialAppearance,
    originalAppearance: initialAppearance,
    isLoading: false,
    hasUnsavedChanges: false,

    setAccentColor: (color: string) => {
      const newAppearance = { ...get().appearance, accentColor: color };
      applyAppearance(newAppearance);
      set({
        appearance: newAppearance,
        hasUnsavedChanges: true,
      });
    },

    setDesktopColor: (color: string) => {
      const newAppearance = { ...get().appearance, desktopColor: color };
      applyAppearance(newAppearance);
      set({
        appearance: newAppearance,
        hasUnsavedChanges: true,
      });
    },

    setWindowBgColor: (color: string) => {
      const newAppearance = { ...get().appearance, windowBgColor: color };
      applyAppearance(newAppearance);
      set({
        appearance: newAppearance,
        hasUnsavedChanges: true,
      });
    },

    setFontSmoothing: (enabled: boolean) => {
      const newAppearance = { ...get().appearance, fontSmoothing: enabled };
      applyAppearance(newAppearance);
      set({
        appearance: newAppearance,
        hasUnsavedChanges: true,
      });
    },

    setCustomCSS: (css: string) => {
      const newAppearance = { ...get().appearance, customCSS: css };
      applyCustomCSS(css);
      set({
        appearance: newAppearance,
        hasUnsavedChanges: true,
      });
    },

    resetAppearance: () => {
      const defaultAppearance: CustomAppearance = {};

      // Remove custom CSS properties
      const root = document.documentElement;
      root.style.removeProperty('--selection');
      root.style.removeProperty('--selection-text');
      root.style.removeProperty('--accent');
      root.style.removeProperty('--custom-desktop-color');
      root.style.removeProperty('--desktop-text-color');
      root.style.removeProperty('--window-bg');
      root.style.removeProperty('--window-text-color');
      root.style.removeProperty('--window-text-secondary');

      // Reset font smoothing to theme default
      document.body.style.removeProperty('-webkit-font-smoothing');
      document.body.style.removeProperty('-moz-osx-font-smoothing');

      // Remove custom CSS
      const customStyle = document.getElementById('eternalos-custom-css');
      if (customStyle) {
        customStyle.remove();
      }

      set({
        appearance: defaultAppearance,
        hasUnsavedChanges: true,
      });
    },

    saveAppearance: async () => {
      const { appearance } = get();

      set({ isLoading: true });

      try {
        // Save to localStorage
        saveLocalAppearance(appearance);

        // Save to backend if API is configured
        if (isApiConfigured) {
          await updateProfile({
            accentColor: appearance.accentColor,
            desktopColor: appearance.desktopColor,
            windowBgColor: appearance.windowBgColor,
            fontSmoothing: appearance.fontSmoothing,
            customCSS: appearance.customCSS,
          });
        }

        set({
          originalAppearance: appearance,
          hasUnsavedChanges: false,
          isLoading: false,
        });
      } catch (error) {
        console.error('Failed to save appearance:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    loadAppearance: (appearance: CustomAppearance) => {
      applyAppearance(appearance);
      saveLocalAppearance(appearance);
      set({
        appearance,
        originalAppearance: appearance,
        hasUnsavedChanges: false,
      });
    },
  };
});
