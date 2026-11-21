export function releaseImageRef(image, tag) {
  if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error('リリースのイメージタグが不正です');
  const base = String(image).split('@')[0];
  const colon = base.lastIndexOf(':');
  return (colon > base.lastIndexOf('/') ? base.slice(0, colon) : base) + ':' + tag;
}

export function releaseContainerConfig(config, tag, service) {
  if (!tag) return config;
  return {
    ...config,
    Image: releaseImageRef(config.Image, tag),
    Env: [...(config.Env || []).filter(value => !/^(TRAILMATE_VERSION|DASHBOARD_VERSION)=/.test(value)
      && (service !== 'dashboard' || !value.startsWith('DASHBOARD_BIND='))),
      ...(service === 'dashboard' ? ['DASHBOARD_BIND=0.0.0.0'] : [])]
  };
}

export function pinComposeRelease(text, tag, repository) {
  const images = ['ghcr.io/' + repository, 'ghcr.io/' + repository.split('/')[0] + '/trailmate-dashboard'];
  for (const image of images) {
    const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped + '(?::[^\\s"\' #]+|@sha256:[a-f0-9]+)?', 'g'), releaseImageRef(image, tag));
  }
  return text.replace(
    /(^  dashboard:[ \t]*\r?\n)((?:^ {4}[^\r\n]*(?:\r?\n|$)|^\r?\n)*)/m,
    (_, heading, body) => {
      if (!/^      DASHBOARD_BIND:/m.test(body)) {
        body = body.replace(/^(      DASHBOARD_PORT:[^\r\n]*)(\r?\n)/m, '$1$2      DASHBOARD_BIND: 0.0.0.0$2');
      }
      return heading + body.replace(/^(      - )"?(?:0\.0\.0\.0:)?(\d+):8787"?[ \t]*(?=\r?$)/m, '$1"127.0.0.1:$2:8787"');
    }
  );
}
