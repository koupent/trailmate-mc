import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.js';

type LocaleBundle = {
  commands: Record<string, string>;
  events: Record<string, string[]>;
};

const cache = new Map<string, LocaleBundle>();

function loadLocale(language: string): LocaleBundle {
  if (cache.has(language)) return cache.get(language)!;
  const file = path.join(projectRoot(), 'locales', `${language}.json`);
  const fallback = path.join(projectRoot(), 'locales', 'ja.json');
  const target = fs.existsSync(file) ? file : fallback;
  const bundle = JSON.parse(fs.readFileSync(target, 'utf8')) as LocaleBundle;
  cache.set(language, bundle);
  return bundle;
}

export type CommentaryVars = Record<string, string | number | null | undefined>;

export function tCommand(language: string, key: string, vars: CommentaryVars = {}): string {
  const bundle = loadLocale(language);
  const template = bundle.commands[key] || key;
  return applyVars(template, vars);
}

export function tEvent(language: string, eventId: string, vars: CommentaryVars = {}): string {
  const bundle = loadLocale(language);
  const lines = bundle.events[eventId] || bundle.events.generic || ['…'];
  const template = lines[Math.floor(Math.random() * lines.length)];
  return applyVars(template, vars);
}

function applyVars(template: string, vars: CommentaryVars): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name];
    if (value == null || value === '') return '';
    return String(value);
  }).replace(/\s{2,}/g, ' ').trim();
}
