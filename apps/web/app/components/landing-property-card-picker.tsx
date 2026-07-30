'use client';

import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { filterLandingProperties, landingOwnership, landingPropertyToll, type LandingPlayer, type LandingProperty } from './landing-property-picker';

type LandingPropertyPickerProps = {
  properties: LandingProperty[];
  players: LandingPlayer[];
  value: string;
  onChange: (propertyName: string) => void;
};

function formatAmount(amount: number) {
  return amount.toLocaleString('zh-CN');
}

function buildingLabel(level: number) {
  return level === 5 ? '大宫殿' : `${level} 级`;
}

export function LandingPropertyCardPicker({ properties, players, value, onChange }: LandingPropertyPickerProps) {
  const [query, setQuery] = useState('');
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);
  const visibleProperties = useMemo(
    () => filterLandingProperties(properties, query, selectedOwnerId),
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
        {players.map((player) => (
          <button
            type="button"
            key={player.id}
            className={`landing-owner-filter${selectedOwnerId === player.id ? ' selected' : ''}`}
            aria-pressed={selectedOwnerId === player.id}
            onClick={() => setSelectedOwnerId(player.id)}
          >
            {player.name}
          </button>
        ))}
      </div>
      <p className="landing-property-selection" aria-live="polite">已选：{value || '未选择'}</p>
      {visibleProperties.length ? (
        <div className="landing-property-grid" aria-label="选择落点地产">
          {visibleProperties.map((property) => {
            const ownership = landingOwnership(property, players);
            const selected = property.name === value;
            const ownerName = ownership.ownerName ?? '无主';
            const toll = landingPropertyToll(property, players);
            const accessibleName = `${property.name}，${ownership.label}，所有者 ${ownerName}${property.mortgaged ? '，已抵押' : ''}`;

            return (
              <button
                type="button"
                key={property.name}
                className={`landing-property-card${selected ? ' selected' : ''}`}
                aria-label={accessibleName}
                aria-pressed={selected}
                onClick={() => onChange(property.name)}
              >
                <span className={`landing-property-badge ${ownership.label === '已购' ? 'owned' : 'unowned'}`}>{ownership.label}</span>
                <span className="landing-property-card-title">
                  {property.name}
                </span>
                {selected && <span className="landing-property-selected-label" aria-hidden="true">✅</span>}
                <span className="landing-property-card-meta">
                  <span>购买价<strong>{formatAmount(property.purchasePrice)} 两</strong></span>
                  <span>当前过路费<strong>{formatAmount(toll)} 两</strong></span>
                </span>
                <span className="landing-property-card-meta">
                  <span>所有者<strong>{ownerName}</strong></span>
                  <span>建筑<strong>{buildingLabel(property.level)}</strong></span>
                </span>
                {property.mortgaged && <span className="landing-property-mortgaged">已抵押</span>}
              </button>
            );
          })}
        </div>
      ) : <div className="empty no-margin">没有找到匹配的地产</div>}
    </div>
  );
}
