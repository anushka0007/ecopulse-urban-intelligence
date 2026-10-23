export function calculateRiskScore(fill, growth) {
  return Math.min(100, Math.round(fill * 0.68 + Math.min(growth * 7, 25) + Math.max(0, fill - 70) * 0.18))
}

export function classifyRisk(score) {
  return score >= 80 ? 'Critical' : score >= 65 ? 'High' : score >= 40 ? 'Moderate' : 'Low'
}

export function estimateTimeToOverflow(fill, growth) {
  return Math.max(0, Math.round((100 - fill) / Math.max(growth, 0.1) * 10) / 10)
}

export function assessZone(zone, fill = zone.fill) {
  const score = calculateRiskScore(fill, zone.growth)
  const category = classifyRisk(score)
  const eta = estimateTimeToOverflow(fill, zone.growth)
  const action = category === 'Critical' ? 'Dispatch immediately'
    : category === 'High' ? 'Collect within 4 hours'
      : category === 'Moderate' ? 'Schedule next collection cycle' : 'Continue routine monitoring'
  const riskFactors = {
    fill: Math.round(fill * 0.68 * 10) / 10,
    growth: Math.round(Math.min(zone.growth * 7, 25) * 10) / 10,
    highFill: Math.round(Math.max(0, fill - 70) * 0.18 * 10) / 10,
  }
  const explanation = `${category} risk (${score}/100): ${fill}% fill contributes ${riskFactors.fill} points; ${zone.growth}% hourly growth contributes ${riskFactors.growth}; high-fill pressure contributes ${riskFactors.highFill}. Estimated overflow in ${eta} hours. ${action}.`
  return { risk: score, category, eta, action, riskFactors, explanation }
}
