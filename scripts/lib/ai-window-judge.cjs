/**
 * `probe-ai-window.cjs` 的判定逻辑（与自动机分离，便于用桩测试）。
 *
 * 两个判定都只回答「这次返回值是否符合修复后的口径」，不做任何网络与 UI 操作：
 *
 * - {@link judgeOversizeInput}：超长输入必须**在花配额之前**被拒。除了分类正确，
 *   还要看 `usage` / `safety` 是否为空、有没有告警——这三项一起才说明服务端没有
 *   为这次请求做任何子调用（没扣检测配额、没调模型）。
 * - {@link judgeLongOutput}：长输出必须**检全了才返回**。输出本身没到检测窗口时
 *   这一档没被覆盖，判定为 `covered: false`（不算通过，也不算失败）——
 *   「模型这次没输出那么长」不能当成修复被验证过。
 */

/** 一次调用的返回值（云函数 response 的形状，字段缺失按 undefined 处理）。 */
function responseOf(result) {
  return result !== null && typeof result === 'object' ? result : {};
}

function describe(result) {
  const response = responseOf(result);
  return `ok=${response.ok} failureClass=${JSON.stringify(response.failureClass || '')}`;
}

/**
 * 超长输入的期望：`ok: false` + `invalid_request` + 零子调用。
 *
 * 修复前这里会返回 `ok: true`（带着 `checked: false` 的告警把窗口外的文字送进模型），
 * 因此这条判定能区分修复前后。
 */
function judgeOversizeInput(result, limit) {
  const response = responseOf(result);
  const reasons = [];
  if (response.ok !== false) reasons.push(`期望被拒，实际 ${describe(result)}`);
  if (response.failureClass !== 'invalid_request') {
    reasons.push(`期望 failureClass=invalid_request，实际 ${JSON.stringify(response.failureClass || '')}`);
  }
  if (response.usage !== null && response.usage !== undefined) reasons.push('用量不为空：说明发生了子调用（可能花了检测配额）');
  if (response.safety !== null && response.safety !== undefined) reasons.push('带回了检测结论：说明检测已经跑过，拒绝来得太晚');
  if (Array.isArray(response.warnings) && response.warnings.length > 0) {
    reasons.push('提前拒绝却带有告警：无法确认没有发生检测或模型子调用');
  }
  if (!String(response.detail || '').includes(String(limit))) {
    reasons.push(`detail 应写明上限 ${limit}，实际 ${JSON.stringify(response.detail || '')}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** 整轮复验：0 两档通过，2 判据不符，3 长输出未覆盖（须换提示重跑）。 */
function probeRunExitCode(oversizeVerdict, longVerdict) {
  if (!oversizeVerdict.pass || (longVerdict.covered && !longVerdict.pass)) return 2;
  if (!longVerdict.covered) return 3;
  return 0;
}

/**
 * 长输出的期望：`ok: true` 时必须是**整段检完**（`checked: true` 且没有 `checked=false` 告警）。
 *
 * 三种结果都算符合修复后的口径，判定分成两类报告：
 * - 输出没到 `inputLimit` → `covered: false`：模型没写那么长，这一档无从验证，
 *   不能记成通过（换更长的提示或提高 maxTokens 后重跑）。
 * - 输出超过 `outputLimit`（分片上限）被服务端拒 → 通过且注明：宁可这次不给结果，
 *   也不上屏未经检测的文字，这正是修复要求的 fail-closed 行为。
 * - 其余情况要求 `ok: true`、`checked: true`、无 `checked=false` 告警。
 */
function judgeLongOutput(result, inputLimit, outputLimit, textLength) {
  const response = responseOf(result);
  const reasons = [];
  const detail = String(response.detail || '');
  // 先判「被分片上限拒」这一支：这种情况下 text 是空的，量不到模型实际写了多长。
  if (response.ok === false && response.failureClass === 'internal' && detail.includes(String(outputLimit))) {
    return {
      pass: true,
      covered: true,
      reasons: [`输出超过分片上限 ${outputLimit} 字，服务端按 internal 拒绝了这次回答：这是修复要求的 fail-closed 行为`],
    };
  }
  const length = typeof textLength === 'number' ? textLength : String(response.text || '').length;
  if (length < inputLimit) {
    return {
      pass: false,
      covered: false,
      reasons: [`输出 ${length} 字，未达到检测窗口 ${inputLimit} 字：这一档没被覆盖（换更长的提示或提高 maxTokens 后重跑）`],
    };
  }
  if (response.ok !== true) reasons.push(`期望成功返回，实际 ${describe(result)}`);
  const safety = response.safety;
  if (safety === null || safety === undefined || safety.checked !== true) {
    reasons.push(`safety.checked 应为 true，实际 ${safety === null || safety === undefined ? '(空)' : safety.checked}`);
  }
  const warnings = Array.isArray(response.warnings) ? response.warnings : [];
  const uncheckedWarning = warnings.find((warning) => String(warning).includes('checked=false'));
  if (uncheckedWarning !== undefined) {
    reasons.push(`返回值带着「没检全」的告警：${String(uncheckedWarning).slice(0, 200)}`);
  }
  return { pass: reasons.length === 0, covered: true, reasons };
}

module.exports = { judgeLongOutput, judgeOversizeInput, probeRunExitCode };
