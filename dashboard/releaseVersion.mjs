export function releaseImageRef(image, tag) {
  if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error('リリースのイメージタグが不正です');
  const base = String(image).split('@')[0];
  const colon = base.lastIndexOf(':');
  return (colon > base.lastIndexOf('/') ? base.slice(0, colon) : base) + ':' + tag;
}

export function releaseContainerConfig(config, tag) {
  if (!tag) return config;
  return {
    ...config,
    Image: releaseImageRef(config.Image, tag),
    Env: [...(config.Env || []).filter(value => !/^(TRAILMATE_VERSION|DASHBOARD_VERSION)=/.test(value)),
      'TRAILMATE_VERSION=' + tag, 'DASHBOARD_VERSION=' + tag]
  };
}

export function pinComposeRelease(text, tag, repository) {
  const images = ['ghcr.io/' + repository, 'ghcr.io/' + repository.split('/')[0] + '/trailmate-dashboard'];
  for (const image of images) {
    const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped + '(?::[^\\s"\' #]+|@sha256:[a-f0-9]+)?', 'g'), releaseImageRef(image, tag));
  }
  return text;
}
