'use client';

import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { LandingPropertyCardPicker } from './landing-property-card-picker';
import type {
  LandingPlayer,
  LandingProperty,
} from './landing-property-picker';

export type PlayerAssetOverviewPlayer = LandingPlayer & {
  balance: number;
};

export type PlayerAssetSummary = {
  ownedProperties: LandingProperty[];
  propertyCount: number;
  regularBuildingCount: number;
  palaceCount: number;
};

export function nextExpandedPlayerId(
  currentPlayerId: string | null,
  requestedPlayerId: string,
) {
  return currentPlayerId === requestedPlayerId ? null : requestedPlayerId;
}

export function summarizePlayerAssets(
  playerId: string,
  properties: LandingProperty[],
): PlayerAssetSummary {
  const ownedProperties = properties.filter(
    (property) => property.ownerId === playerId,
  );

  return {
    ownedProperties,
    propertyCount: ownedProperties.length,
    regularBuildingCount: ownedProperties.reduce(
      (total, property) =>
        property.level >= 1 && property.level <= 4
          ? total + property.level
          : total,
      0,
    ),
    palaceCount: ownedProperties.filter((property) => property.level === 5)
      .length,
  };
}

export function PlayerAssetAccordion({
  players,
  properties,
}: {
  players: PlayerAssetOverviewPlayer[];
  properties: LandingProperty[];
}) {
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null);
  const accordionId = useId();

  useEffect(() => {
    if (
      expandedPlayerId &&
      !players.some((player) => player.id === expandedPlayerId)
    ) {
      setExpandedPlayerId(null);
    }
  }, [expandedPlayerId, players]);

  if (!players.length) return <div className="empty">暂无玩家</div>;

  return (
    <div className="player-asset-accordion">
      {players.map((player) => {
        const summary = summarizePlayerAssets(player.id, properties);
        const expanded = expandedPlayerId === player.id;
        const triggerId = [accordionId, player.id, 'trigger'].join('-');
        const panelId = [accordionId, player.id, 'panel'].join('-');

        return (
          <section
            className={[
              'player-asset-item',
              expanded ? 'expanded' : '',
            ].filter(Boolean).join(' ')}
            key={player.id}
          >
            <button
              id={triggerId}
              type="button"
              className="player-asset-trigger"
              aria-label={player.name + '资产详情'}
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() =>
                setExpandedPlayerId((current) =>
                  nextExpandedPlayerId(current, player.id),
                )
              }
            >
              <span className="avatar player-asset-avatar">
                {player.name[0]}
              </span>
              <span className="player-asset-heading">
                <strong>{player.name}</strong>
                <small>资产概况</small>
              </span>
              <span className="player-asset-metrics">
                <span>
                  <small>现金</small>
                  <strong>{player.balance.toLocaleString('zh-CN')} 两</strong>
                </span>
                <span>
                  <small>地产</small>
                  <strong>{summary.propertyCount} 块</strong>
                </span>
                <span>
                  <small>普通建筑</small>
                  <strong>{summary.regularBuildingCount} 栋</strong>
                </span>
                <span>
                  <small>大宫殿</small>
                  <strong>{summary.palaceCount} 座</strong>
                </span>
              </span>
              <ChevronDown className="player-asset-chevron" aria-hidden="true" />
            </button>
            {expanded && (
              <div
                id={panelId}
                className="player-asset-panel"
                role="region"
                aria-labelledby={triggerId}
              >
                <LandingPropertyCardPicker
                  mode="browse"
                  properties={summary.ownedProperties}
                  players={[player]}
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
