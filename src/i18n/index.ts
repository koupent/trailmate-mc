import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.js';

type LocaleBundle = {
  commands: Record<string, string>;
  events: Record<string, string[]>;
  movement?: Record<string, string>;
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

export function tEvent(
  language: string,
  eventId: string,
  vars: CommentaryVars = {},
  options: { excludeMessage?: string } = {}
): string {
  const bundle = loadLocale(language);
  const lines = bundle.events[eventId] || bundle.events.generic || ['…'];
  const rendered = lines.map((template) => applyVars(template, vars));
  const excludedPattern = options.excludeMessage
    ? messagePattern(options.excludeMessage)
    : null;
  const alternatives = rendered.length > 1 && excludedPattern
    ? rendered.filter((message) => messagePattern(message) !== excludedPattern)
    : rendered;
  const choices = alternatives.length > 0 ? alternatives : rendered;
  return choices[Math.floor(Math.random() * choices.length)];
}

function messagePattern(message: string): string {
  return message.replace(/\d+(?:\.\d+)?/g, '#');
}

export function tMovement(language: string, key: string, vars: CommentaryVars = {}): string {
  const bundle = loadLocale(language);
  const template = bundle.movement?.[key] || key;
  return applyVars(template, vars);
}

function applyVars(template: string, vars: CommentaryVars): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name];
    if (value == null || value === '') return '';
    return String(value);
  }).replace(/\s{2,}/g, ' ').trim();
}
