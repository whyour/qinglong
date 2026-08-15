"use strict";

(function () {
  const commandSchema = "qinglong/cluster-copilot-console-read-request@v1";
  const sessionForm = document.getElementById("session-form");
  const sessionInput = document.getElementById("session-token");
  const targetForm = document.getElementById("target-form");
  const inspectButton = document.getElementById("inspect-button");
  const outputButton = document.getElementById("output-button");
  const emptyState = document.getElementById("empty-state");
  const resultView = document.getElementById("result-view");
  const outputPanel = document.getElementById("output-panel");
  const outputText = document.getElementById("output-text");
  const message = document.getElementById("message");
  const statusChip = document.getElementById("status-chip");
  let sessionToken = "";
  let currentTarget = null;

  const setText = function (id, value) {
    document.getElementById(id).textContent =
      value === null || value === undefined || value === "" ? "—" : String(value);
  };

  const setMessage = function (value, tone) {
    message.textContent = value;
    message.dataset.tone = tone || "neutral";
  };

  const dateTime = function (value) {
    if (!Number.isSafeInteger(value)) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(value));
  };

  const setBusy = function (busy) {
    inspectButton.disabled = busy;
    outputButton.disabled =
      busy || !currentTarget || currentTarget.outputAvailable !== true;
  };

  const request = async function (operation, target) {
    const response = await fetch("/api/v1/copilot/" + operation, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        Authorization: "QL3-Console " + sessionToken,
      },
      body: JSON.stringify({
        schema: commandSchema,
        operation: operation,
        projectId: target.projectId,
        sourceRunId: target.sourceRunId,
        requestId: target.requestId,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(
        typeof body.code === "string" ? body.code : "console_request_failed",
      );
      error.code = typeof body.code === "string" ? body.code : "console_request_failed";
      throw error;
    }
    return body;
  };

  const targetFromForm = function () {
    const form = new FormData(targetForm);
    return {
      projectId: String(form.get("projectId") || "").trim(),
      sourceRunId: String(form.get("sourceRunId") || "").trim(),
      requestId: String(form.get("requestId") || "").trim(),
    };
  };

  const renderInspection = function (response) {
    const result = response.result;
    const fact = result.result;
    currentTarget = {
      projectId: fact.projectId,
      sourceRunId: fact.sourceRunId,
      requestId: fact.requestId,
      outputAvailable: fact.outputAvailable,
    };
    emptyState.hidden = true;
    resultView.hidden = false;
    outputPanel.hidden = true;
    outputText.textContent = "";
    setText("admitted-at", dateTime(fact.admittedAtMs));
    setText("stage", fact.stage || (fact.status === "running" ? "processing" : null));
    setText("outcome", fact.outcome || fact.status);
    setText("diagnosis-run", fact.diagnosisRunId);
    setText("reason", fact.reason);
    setText(
      "tokens",
      fact.usage === null ? null : fact.usage.totalTokens,
    );
    setText(
      "cost",
      fact.usage === null || fact.usage.costMicros === null
        ? null
        : "$" + (fact.usage.costMicros / 1000000).toFixed(6),
    );
    statusChip.textContent = fact.status === "running" ? "诊断进行中" : fact.outcome;
    statusChip.dataset.tone =
      fact.status === "running"
        ? "running"
        : fact.outcome === "succeeded"
          ? "success"
          : "failed";
    outputButton.disabled = fact.outputAvailable !== true;
    setMessage(
      fact.outputAvailable
        ? "状态已验证。诊断内容仍未读取。"
        : "状态已验证；当前没有可读取的诊断内容。",
    );
  };

  const renderOutput = function (response) {
    const fact = response.result.result;
    outputPanel.hidden = false;
    outputText.textContent = fact.result.text;
    setText("finish-reason", fact.result.finishReason);
    setText("output-bytes", fact.reference.outputBytes);
    setText("content-digest", fact.reference.contentDigest);
    setMessage("诊断内容已显式读取；请把它当作不可信建议进行复核。");
    outputPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  sessionForm.addEventListener("submit", function (event) {
    event.preventDefault();
    const candidate = sessionInput.value.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(candidate)) {
      setMessage("浏览器访问密钥格式无效。", "error");
      return;
    }
    sessionToken = candidate;
    sessionInput.value = "";
    sessionForm.hidden = true;
    targetForm.hidden = false;
    setMessage("本次页面已解锁。访问密钥只保留在内存中。");
    document.getElementById("project-id").focus();
  });

  targetForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const target = targetFromForm();
    setBusy(true);
    setMessage("正在读取 durable status…");
    try {
      const response = await request("inspect", target);
      renderInspection(response);
    } catch (error) {
      currentTarget = null;
      outputPanel.hidden = true;
      statusChip.textContent = "读取失败";
      statusChip.dataset.tone = "failed";
      setMessage("无法读取诊断状态：" + error.code, "error");
    } finally {
      setBusy(false);
    }
  });

  outputButton.addEventListener("click", async function () {
    if (!currentTarget || currentTarget.outputAvailable !== true) return;
    setBusy(true);
    setMessage("正在显式读取诊断内容…");
    try {
      const response = await request("output", currentTarget);
      renderOutput(response);
    } catch (error) {
      setMessage("无法读取诊断内容：" + error.code, "error");
    } finally {
      setBusy(false);
    }
  });

  window.addEventListener("pagehide", function () {
    sessionToken = "";
    currentTarget = null;
    outputText.textContent = "";
  });
})();
