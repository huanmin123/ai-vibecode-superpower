function count(values) {
  return Array.isArray(values) ? values.length : 0;
}

function clarificationQuestion(reason) {
  if (reason === 'ambiguous_candidates') {
    return '当前已找到多个可解释现象的候选；请补充最接近故障时的一段完整报错或堆栈（最好含文件:行号，跨服务问题可提供 trace/request ID），用来区分这些路径。';
  }
  if (reason === 'no_index_match') {
    return '当前描述没有命中可验证的代码节点；请提供一次完整报错或堆栈（含文件:行号）或失败测试名称；如果没有报错，请给最短复现步骤以及期望结果和实际结果。';
  }
  return '请提供一次完整报错或堆栈（最好含文件:行号）；如果没有报错，请给最短复现步骤以及期望结果和实际结果。';
}

function decision(action, reasonCodes, question = null) {
  return {
    action,
    shouldAnalyze: action !== 'clarify_first',
    blocking: action === 'clarify_first',
    reasonCodes,
    question,
  };
}

export function assessIncidentInput({ incident = null, explicitQueries = [], seedIds = [], runtimeEvidence = null, logFile = null } = {}) {
  const externalEvidence = count(explicitQueries) > 0 || count(seedIds) > 0 || count(runtimeEvidence) > 0 || Boolean(logFile)
    || Boolean(runtimeEvidence && typeof runtimeEvidence === 'object' && count(runtimeEvidence.events) > 0);
  if (externalEvidence) return decision('analyze', ['caller_provided_explicit_evidence']);
  if (!incident) return decision('clarify_first', ['missing_incident_description'], clarificationQuestion('missing_input'));
  if (count(incident.sourceLocations) > 0) return decision('analyze', ['source_location_available']);
  const deterministicAnchors = count(incident.files) + count(incident.errorCodes) + count(incident.configKeys) + count(incident.endpoints)
    + count(incident.sqlIdentifiers) + count(incident.traceIds) + count(incident.requestIds) + count(incident.serviceNames);
  if (deterministicAnchors > 0) {
    return decision('analyze_and_clarify', ['deterministic_anchor_without_source_location'], clarificationQuestion('ambiguous_candidates'));
  }
  if (count(incident.symbols) > 0) {
    return decision('analyze_and_clarify', ['symbol_only_description'], clarificationQuestion('ambiguous_candidates'));
  }
  return decision('clarify_first', ['no_deterministic_anchor'], clarificationQuestion('missing_input'));
}

export function assessAnalysisResult({ incident = null, evidence, analysis, preflight }) {
  const mapped = count(evidence?.runtime?.mapped);
  const seeds = count(evidence?.seeds);
  const hypotheses = count(analysis?.hypotheses);
  if (mapped > 0) {
    return decision('analyze', ['source_location_mapped']);
  }
  if (seeds === 0 || hypotheses === 0) {
    return decision('clarify_first', ['no_index_match'], clarificationQuestion('no_index_match'));
  }
  if (count(incident?.sourceLocations) > 0) {
    return decision('analyze_and_clarify', ['source_location_not_mapped'], clarificationQuestion('ambiguous_candidates'));
  }
  if (preflight?.action === 'analyze_and_clarify' || analysis?.coverage?.truncated === true) {
    return decision('analyze_and_clarify', [
      ...(preflight?.reasonCodes ?? []),
      ...(analysis?.coverage?.truncated === true ? ['bounded_graph_truncated'] : []),
    ], clarificationQuestion('ambiguous_candidates'));
  }
  return decision('analyze', ['bounded_candidates_available']);
}
