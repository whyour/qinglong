import intl from "react-intl-universal";
import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  message,
  Input,
  Form,
  Statistic,
  Button,
  Typography,
} from "antd";
import { request } from "@/utils/http";
import config from "@/utils/config";
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import { PageLoading } from "@ant-design/pro-layout";
import { CrontabStatus } from "./type";
import Ansi from "ansi-to-react";

const { Countdown } = Statistic;
const LOG_CHUNK_BYTES = 256 * 1024;
const MAX_LOG_VIEW_CHARS = 1024 * 1024;

const CronLogModal = ({
  cron,
  handleCancel,
  data,
  logUrl,
}: {
  cron?: any;
  handleCancel: () => void;
  data?: string;
  logUrl?: string;
}) => {
  const [value, setValue] = useState<string>(intl.get("启动中..."));
  const [loading, setLoading] = useState<any>(true);
  const [executing, setExecuting] = useState<any>(true);
  const [isPhone, setIsPhone] = useState(false);
  const scrollInfoRef = useRef({ value: 0, down: true });
  const logOffsetRef = useRef<number>();
  const valueRef = useRef(value);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const uniqPath = logUrl ? logUrl : String(cron?.id);

  const getCronLog = (isFirst?: boolean) => {
    if (isFirst) {
      setLoading(true);
    }
    const baseUrl = logUrl ? logUrl : `${config.apiPrefix}crons/${cron.id}/log`;
    const separator = baseUrl.includes("?") ? "&" : "?";
    const offset = isFirst ? undefined : logOffsetRef.current;
    const pagination = `${separator}limit=${LOG_CHUNK_BYTES}${
      isFirst ? "&tail=true" : offset !== undefined ? `&offset=${offset}` : ""
    }`;
    request
      .get(`${baseUrl}${pagination}`)
      .then(({ code, data, logStatus, nextOffset }) => {
        if (code !== 200 || localStorage.getItem("logCron") !== uniqPath) {
          return;
        }

        const hasNext = logStatus === "running";
        const chunk = (data as string) || "";
        let log = isFirst ? chunk : `${valueRef.current}${chunk}`;
        if (!log && !hasNext) {
          log = intl.get("暂无日志");
        }
        if (log.length > MAX_LOG_VIEW_CHARS) {
          log = log.slice(-MAX_LOG_VIEW_CHARS);
        }
        valueRef.current = log;
        setValue(log);
        if (typeof nextOffset === "number") {
          logOffsetRef.current = nextOffset;
        }
        setExecuting(hasNext);

        if (chunk || !hasNext) {
          autoScroll();
        }
        if (hasNext) {
          pollTimerRef.current = setTimeout(() => getCronLog(), 2000);
        }
      })
      .finally(() => {
        if (isFirst) {
          setLoading(false);
        }
      });
  };

  const autoScroll = () => {
    if (!scrollInfoRef.current.down) {
      return;
    }

    setTimeout(() => {
      document
        .querySelector("#log-flag")
        ?.scrollIntoView({ behavior: "smooth" });
    }, 600);
  };

  const cancel = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
    }
    localStorage.removeItem("logCron");
    handleCancel();
  };

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    const sTop = (e.target as HTMLDivElement).scrollTop;
    if (scrollInfoRef.current.down) {
      scrollInfoRef.current = {
        value: sTop,
        down: sTop - scrollInfoRef.current.value > -5 || !sTop,
      };
    }
  };

  const titleElement = () => {
    return (
      <div style={{ display: "flex", alignItems: "center" }}>
        {(executing || loading) && <Loading3QuartersOutlined spin />}
        {!executing && !loading && <CheckCircleOutlined />}
        <Typography.Text ellipsis={true} style={{ marginLeft: 5 }}>
          {cron && cron.name}
        </Typography.Text>
      </div>
    );
  };

  useEffect(() => {
    if (cron && cron.id) {
      logOffsetRef.current = undefined;
      getCronLog(true);
    }
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, [cron]);

  useEffect(() => {
    if (data) {
      valueRef.current = data;
      setValue(data);
    }
  }, [data]);

  useEffect(() => {
    setIsPhone(document.body.clientWidth < 768);
  }, []);

  return (
    <Modal
      title={titleElement()}
      open={true}
      centered
      className="log-modal"
      forceRender
      onOk={() => cancel()}
      onCancel={() => cancel()}
      footer={[
        <Button type="primary" onClick={() => cancel()}>
          {intl.get("知道了")}
        </Button>,
      ]}
    >
      <div onScroll={handleScroll} className="log-container">
        {loading ? (
          <PageLoading />
        ) : (
          <pre
            style={
              isPhone
                ? {
                  fontFamily: "Source Code Pro",
                  zoom: 0.83,
                }
                : {}
            }
          >
            <Ansi>{value}</Ansi>
          </pre>
        )}
        <div id="log-flag"></div>
      </div>
    </Modal>
  );
};

export default CronLogModal;
