'use client';

import { Search } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import {
  filterLandingProperties,
  landingPropertyToll,
  propertyCharacterMeta,
  propertyOwner,
  sortPropertiesByOwnership,
  visibleLandingPlayers,
  type LandingPlayer,
  type LandingProperty,
  type PropertyOwnerFilter,
} from './landing-property-picker';

type LandingPropertyPickerProps = {
  properties: LandingProperty[];
  players: LandingPlayer[];
  mode?: 'browse' | 'landing';
  value?: string;
  onChange?: (propertyName: string) => void;
  viewerPlayerId?: string;
};

function formatAmount(amount: number) {
  return amount.toLocaleString('zh-CN');
}

function buildingLabel(level: number) {
  return level === 5 ? '大宫殿' : `${level} 级`;
}

function amountLabel(amount: number) {
  return `${formatAmount(amount)} 两`;
}

function DetailCell({ label, amount }: { label: string; amount: number }) {
  return (
    <span className="property-detail-cell">
      <span>{label}</span>
      <strong>{amountLabel(amount)}</strong>
    </span>
  );
}

export function PropertyCardDetails({ property }: { property: LandingProperty }) {
  const tollAt = (level: number) => property.tolls[level] ?? 0;

  return (
    <div className="property-details-panel">
      <p className="property-detail-heading">价格信息</p>
      <div className="property-detail-grid property-price-grid">
        <DetailCell label="购买 / 卖回价" amount={property.purchasePrice} />
        <DetailCell label="抵押价" amount={property.mortgage} />
        <DetailCell label="建筑费" amount={property.build} />
        <DetailCell label="建筑出售价" amount={property.buildingSell} />
      </div>
      <p className="property-detail-heading property-rent-heading">建筑等级过路费</p>
      <div className="property-empty-land-tier">
        <span>空地（0级）</span>
        <strong>{amountLabel(tollAt(0))}</strong>
      </div>
      <div className="property-detail-grid property-level-rent-grid">
        {[1, 2, 3, 4].map((level) => (
          <DetailCell key={level} label={`${level} 级`} amount={tollAt(level)} />
        ))}
      </div>
      <div className="property-palace-tier">
        <span>大宫殿（5级）</span>
        <strong>{amountLabel(tollAt(5))}</strong>
      </div>
    </div>
  );
}

export function LandingPropertyCardPicker({
  properties,
  players,
  mode = 'landing',
  value = '',
  onChange,
  viewerPlayerId,
}: LandingPropertyPickerProps) {
  const [query, setQuery] = useState('');
  const [ownerFilter, setOwnerFilter] = useState<PropertyOwnerFilter>('all');
  const [expandedProperties, setExpandedProperties] = useState<Set<string>>(() => new Set());
  const propertyPlayers = useMemo(() => visibleLandingPlayers(players), [players]);
  const activeOwnerFilter = ownerFilter === 'all'
    || ownerFilter === 'unowned'
    || propertyPlayers.some((player) => player.id === ownerFilter)
    ? ownerFilter
    : 'all';
  const visibleProperties = useMemo(
    () => sortPropertiesByOwnership(
      filterLandingProperties(properties, players, query, activeOwnerFilter),
    ),
    [activeOwnerFilter, players, properties, query],
  );

  function toggleExpanded(propertyName: string) {
    setExpandedProperties((current) => {
      const next = new Set(current);
      if (next.has(propertyName)) next.delete(propertyName);
      else next.add(propertyName);
      return next;
    });
  }

  function activateProperty(propertyName: string) {
    if (mode === 'browse') toggleExpanded(propertyName);
    else onChange?.(propertyName);
  }

  function handleCardKeyDown(event: KeyboardEvent<HTMLElement>, propertyName: string) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activateProperty(propertyName);
  }

  return (
    <div className={`landing-property-picker ${mode}-property-picker`}>
      {mode === 'browse' && (
        <p className="property-expand-hint">点击地产卡展开详情，再次点击即可收起</p>
      )}
      <div className="landing-property-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label={mode === 'landing' ? '搜索声明落点' : '搜索地产或角色'}
          placeholder="搜索地产、角色或拼音"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="landing-property-owner-filters" role="group" aria-label="按角色筛选">
        <button
          type="button"
          className={`landing-owner-filter property-owner-filter property-theme-treasury${activeOwnerFilter === 'all' ? ' selected' : ''}`}
          aria-pressed={activeOwnerFilter === 'all'}
          onClick={() => setOwnerFilter('all')}
        >
          全部
        </button>
        <button
          type="button"
          className={`landing-owner-filter property-owner-filter property-theme-unowned${activeOwnerFilter === 'unowned' ? ' selected' : ''}`}
          aria-pressed={activeOwnerFilter === 'unowned'}
          onClick={() => setOwnerFilter('unowned')}
        >
          无主
        </button>
        {propertyPlayers.map((player) => {
          const character = propertyCharacterMeta(player.characterId);
          if (!character) return null;
          return (
            <button
              type="button"
              key={player.id}
              className={`landing-owner-filter property-owner-filter property-theme-${character.theme}${activeOwnerFilter === player.id ? ' selected' : ''}`}
              aria-pressed={activeOwnerFilter === player.id}
              onClick={() => setOwnerFilter(player.id)}
            >
              {character.filterLabel}
            </button>
          );
        })}
      </div>
      <div
        className="landing-property-grid"
        aria-label={mode === 'landing' ? '选择落点地产' : '地产信息'}
      >
        {visibleProperties.length ? visibleProperties.map((property) => {
          const ownership = propertyOwner(property, players, viewerPlayerId);
          const selected = mode === 'landing' && property.name === value;
          const expanded = mode === 'browse' && expandedProperties.has(property.name);
          const owner = ownership.player;
          const tollBlocked = Boolean(owner?.tollCollectionBlocked);
          const ownerCharacterName = property.ownerId
            ? ownership.characterName ?? '未知角色'
            : '无主';
          const ownerNickname = property.ownerId
            ? owner?.name ?? '未知玩家'
            : '银行';
          const toll = landingPropertyToll(property, players);
          const accessibleName = [
            property.name,
            ownership.label,
            `所有者 ${ownerCharacterName} ${ownerNickname}`,
            tollBlocked ? '冷宫免过路费' : '',
            property.mortgaged ? '已抵押' : '',
          ].filter(Boolean).join('，');
          const cardClasses = [
            'landing-property-card',
            `property-theme-${ownership.theme}`,
            `${mode}-card`,
            expanded ? 'expanded' : 'collapsed',
            selected ? 'selected' : '',
            property.mortgaged ? 'mortgaged' : '',
          ].filter(Boolean).join(' ');

          return (
            <article
              key={property.name}
              className={cardClasses}
              role="button"
              tabIndex={0}
              aria-label={accessibleName}
              aria-expanded={mode === 'browse' ? expanded : undefined}
              aria-pressed={mode === 'landing' ? selected : undefined}
              onClick={() => activateProperty(property.name)}
              onKeyDown={(event) => handleCardKeyDown(event, property.name)}
            >
              <span className="landing-property-badge">{ownership.label}</span>
              {selected && (
                <span className="property-selected-mark" aria-hidden="true">✓</span>
              )}
              <span className="landing-property-title-line">
                <strong className="landing-property-card-title">{property.name}</strong>
                {tollBlocked && (
                  <span className="property-cold-palace-hint">冷宫 · 免过路费</span>
                )}
              </span>
              <span className="landing-property-card-meta">
                <span>
                  {property.ownerId ? '下级费用' : '购买价'}
                  <strong>
                    {property.ownerId
                      ? property.level < 5
                        ? amountLabel(property.build)
                        : '满级'
                      : amountLabel(property.purchasePrice)}
                  </strong>
                </span>
                <span>
                  当前过路费
                  <strong>{amountLabel(toll)}</strong>
                </span>
                <span>
                  所有者
                  <strong>{ownerCharacterName}</strong>
                  <small className="property-owner-nickname">「{ownerNickname}」</small>
                </span>
                <span>
                  建筑
                  <strong>{buildingLabel(property.level)}</strong>
                </span>
              </span>
              {property.mortgaged && (
                <span className="property-mortgage-stamp" aria-hidden="true">已抵押</span>
              )}
              {expanded && <PropertyCardDetails property={property} />}
            </article>
          );
        }) : (
          <div className="landing-property-empty">
            <strong>没有找到匹配的地产</strong>
            <small>清除关键词或切换“全部”</small>
          </div>
        )}
      </div>
    </div>
  );
}
