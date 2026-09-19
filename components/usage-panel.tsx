import { ArrowUpRight, Coins } from 'lucide-react';
import { estimatedUsd, formatUsd, JEV_PRICING, usageIncomplete, type UsageTotals } from '@/lib/usage';

function Cost({ usage }: { usage: UsageTotals }) {
  const partial = usageIncomplete(usage);
  return <><strong>{partial && usage.inputTokens === 0 ? '집계 대기' : formatUsd(estimatedUsd(usage))}</strong>{partial && usage.inputTokens > 0 && <small>확인된 사용량만</small>}</>;
}

export function UsagePanel({ run, session, replay }: { run: UsageTotals; session: UsageTotals; replay: boolean }) {
  return <section className="panel usage-panel" aria-label="Jev API 사용 요금">
    <div className="usage-heading"><h2><Coins size={16}/> Jev 사용 요금</h2><span>예상 금액 · USD</span></div>
    <div className="usage-grid">
      <div><span>{replay ? '저장된 실험의 예상 요금' : '이번 실험'}</span><div className="usage-amount"><Cost usage={run}/></div><p>전송 확인된 API 호출 {run.calls.toLocaleString()}회 · 모든 층 합산</p></div>
      <div><span>이 페이지 누적</span><div className="usage-amount"><Cost usage={session}/></div><p>재시작해도 유지 · 페이지 새로고침 시 초기화</p></div>
      <div><span>이번 실험의 확인된 토큰</span><div className="usage-tokens"><strong>{run.inputTokens.toLocaleString()}</strong><small>입력</small><strong>{run.outputTokens.toLocaleString()}</strong><small>출력</small></div><p>입력 100만 토큰당 ${JEV_PRICING.inputPerMillionUsd} · 출력 무료</p></div>
    </div>
    {(usageIncomplete(session) || usageIncomplete(run)) && <p className="usage-pending" role="status">페이지 누적 중 응답 대기·확인 불가 요청 {session.unresolvedRequests}건 / 토큰 미보고 호출 {session.unreportedCalls}회. 사용량을 받지 못한 부분은 금액에서 제외됩니다.{replay && usageIncomplete(run) ? ' 불러온 기록에도 미확인 사용량이 있습니다.' : ''}</p>}
    {replay && <p className="usage-pending">기록 재생은 API를 호출하지 않으며, 페이지 누적 요금에 추가되지 않습니다.</p>}
    <div className="usage-footnote"><p>API가 반환한 토큰 × 공개 단가로 계산합니다. 다른 기기의 사용·크레딧·세금 등은 반영하지 않으며, 최종 청구는 TypeSafe에서 확인하세요.</p><div><a href={JEV_PRICING.source} target="_blank" rel="noreferrer">요금 기준 · {JEV_PRICING.checkedAt} <ArrowUpRight size={12}/></a><a href="https://console.typesafe.ai/" target="_blank" rel="noreferrer">TypeSafe 사용 내역 <ArrowUpRight size={12}/></a></div></div>
  </section>;
}
