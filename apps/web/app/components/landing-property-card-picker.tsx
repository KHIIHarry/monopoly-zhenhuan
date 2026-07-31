'use client';

import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  filterLandingProperties,
  landingPropertyToll,
  propertyCharacterMeta,
  propertyOwner,
  sortPropertiesByOwnership,
  visibleLandingPlayers,
  type LandingPlayer,
  type LandingProperty,
} from './landing-property-picker';

type LandingPropertyPickerProps = {
  properties: LandingProperty[];
  players: LandingPlayer[];
  mode?: 'browse' | 'landing';
  value?: string;
  onChange?: (propertyName: string) => void;
};

function formatAmount(amount: number) {
  return amount.toLocaleString('zh-CN');
}

function buildingLabel(level: number) {
  return level === 5 ? '大宫殿' : `${level} 级`;
}

export function LandingPropertyCardPicker({
  properties,
  players,
  mode = 'landing',
  value = '',
  onChange,
}: LandingPropertyPickerProps) {
  const [query, setQuery] = useState('');
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);
  const propertyPlayers = useMemo(() => visibleLandingPlayers(players), [players]);
  const visibleProperties = useMemo(
    () => sortPropertiesByOwnership(filterLandingProperties(properties, query, selectedOwnerId)),
    [properties, query, selectedOwnerId],
  );

  return (
    <div className="landing-property-picker">
      <label className="landing-property-search">
        <span>搜索地产</span>
        <div>
          <Search aria-hidden="true" />
          <input placeholder="搜索地产名称" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
      </label>
      <div className="landing-property-owner-filters" role="group" aria-label="按地产所有者筛选">
        <button
          type="button"
          className={`landing-owner-filter${selectedOwnerId === null ? ' selected' : ''}`}
          aria-pressed={selectedOwnerId === null}
          onClick={() => setSelectedOwnerId(null)}
        >
          全部
        </button>
        {propertyPlayers.map((player) => {
          const character = propertyCharacterMeta(player.characterId);
          if (!character) return null;
          return (
            <button
              type="button"
              key={player.id}
              className={`landing-owner-filter property-owner-filter property-theme-${character.theme}${selectedOwnerId === player.id ? ' selected' : ''}`}
              aria-pressed={selectedOwnerId === player.id}
              onClick={() => setSelectedOwnerId(player.id)}
            >
              {character.name}
            </button>
          );
        })}
      </div>
      {mode === 'landing' && <p className="landing-property-selection" aria-live="polite">已选：{value || '未选择'}</p>}
      {visibleProperties.length ? (
        <div className="landing-property-grid" aria-label={mode === 'landing' ? '选择落点地产' : '地产信息'}>
          {visibleProperties.map((property) => {
            const ownership = propertyOwner(property, players);
            const selected = property.name === value;
            const ownerName = ownership.player
              ? ownership.characterName
                ? `${ownership.characterName}（${ownership.player.name}）`
                : ownership.player.name
              : '无主';
            const toll = landingPropertyToll(property, players);
            const accessibleName = `${property.name}，${ownership.label}，所有者 ${ownerName}${property.mortgaged ? '，已抵押' : ''}`;
            const owner = ownership.player;
            const tollBlocked = Boolean(owner?.tollCollectionBlocked);
            const cardContents = (
              <>
                <span className={`landing-property-badge ${ownership.label === '已持有' ? 'owned' : 'unowned'}`}>{ownership.label}</span>
                <span className="landing-property-card-title">{property.name}</span>
                {mode === 'landing' && selected && <span className="landing-property-selected-label" aria-hidden="true">✅</span>}
                {tollBlocked && <span className="toll-blocked">冷宫中，免过路费</span>}
                <span className="landing-property-card-meta">
                  <span>购买价<strong>{formatAmount(property.purchasePrice)} 两</strong></span>
                  <span>当前过路费<strong>{formatAmount(toll)} 两</strong></span>
                </span>
                <span className="landing-property-card-meta">
                  <span>
                    所有者
                    <strong>
                      {owner ? ownership.characterName ? <>{ownership.characterName}（<span className="property-owner-nickname">{owner.name}</span>）</> : owner.name : '无主'}
                    </strong>
                  </span>
                  <span>建筑<strong>{buildingLabel(property.level)}</strong></span>
                </span>
                <details className="property-details">
                  <summary>查看完整价格与租金</summary>
                  <div className="property-prices">
                    <span>抵押价<strong>{formatAmount(property.mortgage)} 两</strong></span>
                    <span>购买 / 卖回价<strong>{formatAmount(property.purchasePrice)} 两</strong></span>
                    <span>建筑费<strong>{formatAmount(property.build)} 两</strong></span>
                    <span>建筑出售价<strong>{formatAmount(property.buildingSell)} 两</strong></span>
                  </div>
                  <div className="toll-table" aria-label={`${property.name} 0 至 5 级租金`}>
                    {property.tolls.map((amount, level) => <span key={level}>{level} 级 {formatAmount(amount)} 两</span>)}
                  </div>
                </details>
                {property.mortgaged && <span className="property-mortgaged-tag">已抵押</span>}
              </>
            );

              return mode === 'landing' ? (
              <button
                type="button"
                key={property.name}
                className={`landing-property-card property-theme-${ownership.theme}${selected ? ' selected' : ''}`}
                aria-label={accessibleName}
                aria-pressed={selected}
                onClick={() => onChange?.(property.name)}
              >
                {cardContents}
              </button>
            ) : (
              <article key={property.name} className={`landing-property-card property-theme-${ownership.theme}`} aria-label={accessibleName}>
                {cardContents}
              </article>
            );
          })}
        </div>
      ) : <div className="empty no-margin">没有找到匹配的地产</div>}
    </div>
  );
}
