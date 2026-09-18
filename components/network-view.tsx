'use client';
import { ArrowRight, CornerDownLeft, GitBranch, Layers3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ARCHITECTURES, type Architecture, type LayerDecision } from '@/lib/jev';

const LAYOUTS = {
  single: [['action']], serial: [['stability'], ['strategy'], ['action']],
  bundle: [['stability', 'motion', 'rail'], ['action']],
  recurrent: [['stability', 'motion', 'rail'], ['strategy', 'effect'], ['action']],
} as const;
const LABELS: Record<string, string> = { action: '최종 행동', stability: '자세 판단', motion: '회전 방향', rail: '레일 위험', strategy: '전략 판단', effect: '이전 행동 효과' };
const CHOICES: Record<string, string> = { NEAR_UPRIGHT: '직립 근처', DEVIATING: '기울어진 상태', HANGING: '아래로 매달림', CLOCKWISE: '시계 방향', COUNTERCLOCKWISE: '반시계 방향', MIXED: '서로 다른 회전', STILL: '정지 근처', LEFT_RISK: '왼쪽 경계 위험', RIGHT_RISK: '오른쪽 경계 위험', INTERIOR: '레일 내부', BUILD_SWING: '흔들어 올리기', CATCH_UPRIGHT: '직립 포착', MAINTAIN_UPRIGHT: '균형 유지', RECOVER_RAIL: '레일 복귀', IMPROVED: '개선됨', WORSENED: '악화됨', UNCLEAR: '판단 불명', LEFT: '← LEFT', RIGHT: 'RIGHT →' };

export function NetworkView({ architecture, onChange, disabled, layers, pending, observedAt, calls, inputTokens }: { architecture: Architecture; onChange(value: Architecture): void; disabled: boolean; layers?: LayerDecision[]; pending: boolean; observedAt?: number; calls: number; inputTokens: number | null }) {
  const layout = LAYOUTS[architecture], info = ARCHITECTURES[architecture];
  return <section className="panel network-panel"><div className="panel-heading"><div><span className="section-number">03</span><h2>Jev 판단 네트워크</h2><span className="network-heading-sub">DECISION NETWORK</span></div><span className="network-size"><Layers3 size={13}/>{info.layers}층 · {info.nodes}노드</span></div>
    <div className="architecture-options" role="group" aria-label="Jev 네트워크 구성">{Object.entries(ARCHITECTURES).map(([id, option]) => <Button key={id} variant="ghost" disabled={disabled} className={`architecture-option ${architecture === id ? 'active' : ''}`} aria-pressed={architecture === id} onClick={() => onChange(id as Architecture)}><span className="architecture-letter">{String.fromCharCode(65 + Object.keys(ARCHITECTURES).indexOf(id))}</span><span><strong>{option.label}</strong><small>{option.detail}</small></span></Button>)}</div>
    <div className="network-readout"><span>{pending ? '네트워크 응답을 기다립니다. 중간 노드는 응답 완료 후 표시됩니다.' : observedAt == null ? '실제 응답을 받으면 각 노드의 판단과 확률이 표시됩니다.' : `최근 관측 t = ${observedAt.toFixed(2)} s에 대한 실제 Jev 응답`}</span><span>완료 스텝 HTTP {calls}회 · 입력 {inputTokens === null ? '—' : inputTokens.toLocaleString()} tokens</span></div>
    <div className={`network-diagram ${architecture === 'recurrent' ? 'recurrent' : ''}`}><div className="network-terminal"><ActivityMark/><strong>물리 상태</strong><small>x · v · θ · ω</small></div><ArrowRight className="network-arrow"/>{layout.map((ids, i) => <div className="network-stage-group" key={i}><div className="network-layer"><div className="network-layer-label">LAYER {i + 1}<span>{layers?.[i] ? `${Math.round(layers[i].latencyMs)} ms` : '—'}</span></div>{ids.map(id => {
      const node = layers?.[i]?.nodes.find(n => n.id === id);
      return <div key={id} className={`network-node ${id === 'action' ? 'final-node' : ''}`}><div><GitBranch size={12}/><strong>{LABELS[id]}</strong><span>Jev</span></div><p>{node ? CHOICES[node.choice] || node.choice : '응답 없음'}</p>{node ? <details><summary>선택 확률 {(node.probabilities[node.choice] * 100).toFixed(1)}%<small>confidence {node.confidence.toFixed(3)}</small></summary><div className="node-distribution">{Object.entries(node.probabilities).map(([key, value]) => <div key={key}><span>{CHOICES[key] || key}</span><strong>{(value * 100).toFixed(1)}%</strong></div>)}</div></details> : <small className="node-empty">실행 전</small>}</div>;
    })}</div><ArrowRight className="network-arrow"/></div>)}<div className="network-terminal force-terminal"><ArrowRight size={18}/><strong>힘 적용</strong><small>−F / +F</small></div></div>
    {architecture === 'recurrent' && <div className="feedback-line"><CornerDownLeft size={14}/><span>이전 3개 스텝의 상태·행동·Jev 판단을 다음 입력으로 되먹임합니다. 가중치를 학습하지 않습니다.</span></div>}
    <div className="network-footnote"><span>각 노드는 실제 Jev 질문입니다. 같은 층은 한 API 요청에서 독립 평가합니다.</span><strong>보조 제어 0 · 최종 행동은 Jev만 결정</strong></div>
  </section>;
}
function ActivityMark() { return <svg width="24" height="21" viewBox="0 0 24 21" fill="none" aria-hidden="true"><path d="M1 11H6L9 3L14 18L17 11H23" stroke="currentColor" strokeWidth="1.5"/></svg>; }
