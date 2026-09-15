import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

// Some catalogue strings are deliberately not ICU messages: template
// placeholders show the literal WhatsApp `{{1}}` syntax to the user, and
// a few setup steps carry raw HTML destined for dangerouslySetInnerHTML.
// next-intl's ICU parser rejects both.
//
// It rejects them *quietly*: `t()` reports INVALID_MESSAGE / FORMATTING_ERROR
// to onError and then renders the keypath itself, so the field shows
// "Settings.templates.bodyPlaceholder" instead of the placeholder. Nothing
// throws, no build fails, and dev looks the same as prod — which is how
// twelve of these shipped unnoticed.
//
// Such strings must be read with `t.raw()` (bypasses the parser) or
// `t.rich()` (tag handlers). This test fails when one is wired to plain
// `t()`. Reported by @Arifuzzamanjoy in #421.

const MESSAGES_DIR = join(process.cwd(), 'messages');
const SRC = join(process.cwd(), 'src');

type IntlMessages = NonNullable<
  Parameters<typeof createTranslator>[0]['messages']
>;

function catalogues(): {
  locale: string;
  file: string;
  messages: IntlMessages;
}[] {
  return readdirSync(MESSAGES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      locale: file.slice(0, -5),
      file,
      messages: JSON.parse(
        readFileSync(join(MESSAGES_DIR, file), 'utf8')
      ) as IntlMessages,
    }));
}

/** Every leaf keypath (dotted) with a string value. */
function leafKeys(root: unknown, path = ''): string[] {
  const leaves: string[] = [];
  const walk = (node: unknown, prefix: string) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node))
        walk(v, prefix ? `${prefix}.${k}` : k);
      return;
    }
    if (typeof node === 'string') leaves.push(prefix);
  };
  walk(root, path);
  return leaves;
}

/**
 * Leaf keypaths whose value next-intl cannot parse as an ICU message.
 * One translator per locale is reused across keys (the per-leaf creation
 * in the old version made this suite slow and timing-sensitive).
 */
function icuHostileKeys(messages: IntlMessages, locale: string): string[] {
  let code = '';
  const t = createTranslator({
    locale,
    messages,
    onError: (err) => {
      code = err.code;
    },
  });

  return leafKeys(messages).filter((key) => {
    code = '';
    t(key as never);
    // INVALID_MESSAGE only — the parser could not read the string at all,
    // so no call site can rescue it. Deliberately excludes FORMATTING_ERROR,
    // which a well-formed message raises merely because this probe passes no
    // values and no tag handlers; those are `t.rich()` / interpolation sites
    // and are correct as written.
    return code === 'INVALID_MESSAGE';
  });
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

describe('ICU-hostile strings are not read with plain t()', () => {
  it('every {{…}} / raw-HTML message is consumed via t.raw() or t.rich()', () => {
    const en = catalogues().find((c) => c.locale === 'en');
    expect(
      en,
      'messages/en.json must exist as the reference catalogue'
    ).toBeDefined();

    const hostileByLocale = new Map(
      catalogues().map(
        (c) => [c.locale, icuHostileKeys(c.messages, c.locale)] as const
      )
    );
    const refHostile = hostileByLocale.get('en')!;
    // Guard the guard: if this ever hits zero the walk or the parser probe
    // has broken, and the test would pass vacuously.
    expect(refHostile.length).toBeGreaterThan(0);

    // A translation that introduces a parser-invalid string (unbalanced
    // brace, stray HTML, …) breaks that locale alone, so each catalogue
    // must surface exactly the same hostile set as the English reference.
    for (const [locale, hostile] of hostileByLocale) {
      if (locale === 'en') continue;
      expect(
        hostile,
        `messages/${locale}.json diverges from en.json on ICU-hostile keys`
      ).toEqual(refHostile);
    }

    const sources = tsxFiles(SRC).map((path) => ({
      path,
      text: readFileSync(path, 'utf8'),
    }));

    const offenders: string[] = [];

    for (const key of refHostile) {
      const namespace = key.slice(0, key.lastIndexOf('.'));
      const leaf = key.slice(key.lastIndexOf('.') + 1);

      for (const { path, text } of sources) {
        // Leaf names repeat across namespaces ('delete', 'desc', …), so only
        // consider a file that actually opens this key's namespace. The call
        // may use a trailing sub-path (useTranslations('Settings.templates')
        // + t('config.foo')), so match on any namespace prefix.
        const opensNamespace = [
          ...text.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]/g),
        ].some((m) => namespace === m[1] || namespace.startsWith(`${m[1]}.`));
        if (!opensNamespace) continue;

        // A plain call: `t('leaf')` or `t("a.leaf")`, but not `.raw(` / `.rich(`.
        const plainCall = new RegExp(
          String.raw`(?<![.\w])t\(\s*['"](?:[\w.]+\.)?${leaf}['"]`
        );
        if (plainCall.test(text)) {
          offenders.push(
            `${key} — plain t() in ${path.replace(process.cwd() + '/', '')}`
          );
        }
      }
    }

    expect(
      offenders.sort(),
      'these render as their own keypath at runtime; use t.raw() (or t.rich() with tag handlers)'
    ).toEqual([]);
  }, 180_000);
});

describe('locale catalogues stay in sync with the English reference', () => {
  it('every messages/*.json exposes the same key tree as messages/en.json', () => {
    const en = catalogues().find((c) => c.locale === 'en')!;
    const enKeys = new Set(leafKeys(en.messages));

    for (const c of catalogues()) {
      if (c.locale === 'en') continue;
      const otherKeys = leafKeys(c.messages);
      expect(
        {
          missingIn_en: otherKeys.filter((k) => !enKeys.has(k)).sort(),
          extraIn_en: [...enKeys].filter((k) => !otherKeys.includes(k)).sort(),
        },
        `messages/${c.file} diverges from messages/en.json`
      ).toEqual({ missingIn_en: [], extraIn_en: [] });
    }
  }, 60_000);
});
