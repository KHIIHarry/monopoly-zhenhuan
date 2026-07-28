'use client';

import { PosterBackground } from './poster-background';
import { PosterCharacters } from './poster-characters';
import { PosterDecorations } from './poster-decorations';
import { PosterFrame } from './poster-frame';
import { PosterJoinButton } from './poster-join-button';
import { PosterTitle } from './poster-title';

export function LandingPoster({ onJoin }: { onJoin: () => void }) {
  return <main className="landing-page">
    <section className="landing-poster" data-testid="landing-poster" aria-label="甄嬛传大富翁">
      <PosterBackground />
      <PosterCharacters />
      <PosterTitle />
      <PosterDecorations />
      <PosterFrame />
      <PosterJoinButton onJoin={onJoin} />
    </section>
  </main>;
}
