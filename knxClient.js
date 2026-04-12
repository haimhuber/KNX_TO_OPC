import knx from "knx";
import fs from "fs/promises";
import {
    OPCUAServer,
    Variant,
    DataType,
    StatusCodes
} from "node-opcua";

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const CONFIG_PATH = "./knxGroupAddress.json";
const READ_TIMEOUT_MS = 2000;
const DELAY_BETWEEN_READS_MS = 300;
const CYCLE_DELAY_MS = 5000;
const OPC_UA_PORT = 4840;

// key = `${ip}__${ga}`
const runtimePoints = new Map();
// key = ip
const knxConnections = new Map();

async function loadConfig() {
    const data = await fs.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(data);
}

function normalizeConfig(rawConfig) {
    if (!rawConfig || !Array.isArray(rawConfig.gateways)) {
        throw new Error("Invalid config. Expected { gateways: [] }");
    }

    return {
        gateways: rawConfig.gateways.map((gateway) => {
            if (!gateway.IPRS || !Array.isArray(gateway.points)) {
                throw new Error("Each gateway must contain { IPRS, points: [] }");
            }

            return {
                IPRS: gateway.IPRS,
                points: gateway.points.map((point) => ({
                    ga: point.ga,
                    dst: point.dst || ""
                }))
            };
        })
    };
}

function sanitizeNodeName(name) {
    return String(name || "")
        .replace(/[^\w]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "") || "Point";
}

function pointSignature(point) {
    return `${point.ga}|${point.dst}`;
}

function makeRuntimeKey(ip, ga) {
    return `${ip}__${ga}`;
}

async function ensureKnxConnection(ip) {
    const existing = knxConnections.get(ip);

    if (existing?.connected && existing?.connection) {
        return existing.connection;
    }

    if (existing?.connection) {
        try {
            existing.connection.Disconnect();
        } catch {
            // ignore
        }
    }

    const state = {
        connection: null,
        connected: false
    };

    const connection = new knx.Connection({
        ipAddr: ip,
        ipPort: 3671,
        handlers: {
            connected: () => {
                state.connected = true;
                console.log(`[KNX] Connected to ${ip}`);
            },
            error: (err) => {
                state.connected = false;
                console.error(`[KNX] Connection error on ${ip}:`, err);
            }
        }
    });

    state.connection = connection;
    knxConnections.set(ip, state);

    await delay(1500);
    return connection;
}

function isKnxConnected(ip) {
    return knxConnections.get(ip)?.connected === true;
}

async function readDatapoint(ip, item) {

    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {

        const result = await new Promise((resolve) => {

            let responded = false;

            const timeout = setTimeout(() => {
                if (!responded) {
                    resolve("timeout");
                }
            }, READ_TIMEOUT_MS);

            try {
                item.dp.read((src, value) => {

                    if (responded) return;

                    responded = true;
                    clearTimeout(timeout);

                    console.log(
                        `[${ip}] Read response from ${src} | GA ${item.ga} | ${item.dst} | value =`,
                        value
                    );

                    resolve("ok");
                });

            } catch (err) {
                clearTimeout(timeout);
                console.error(`[${ip}] KNX READ ERROR on ${item.ga} (${item.dst}):`, err);
                resolve("error");
            }
        });

        if (result === "ok") {
            return 1;
        }

        if (result === "error") {
            return -1;
        }

        console.warn(
            `[${ip}] Retry ${attempt}/${MAX_RETRIES} failed for ${item.ga}`
        );
    }

    console.error(`[${ip}] KNX READ TIMEOUT after ${MAX_RETRIES} attempts on ${item.ga} (${item.dst})`);

    return 99;
}

function createRuntimePoint(connection, point, ip, namespace, parentFolder) {
    const dp = new knx.Datapoint({
        ga: point.ga,
        dpt: "DPT1.001",
        autoread: false
    });

    dp.bind(connection);

    let currentStatusValue = 0;

    const nodeName = sanitizeNodeName(point.dst || point.ga);

    const opcNode = namespace.addVariable({
        componentOf: parentFolder,
        browseName: nodeName,
        nodeId: `s=${ip}_${point.ga}`,
        dataType: "Int32",
        value: {
            get: () =>
                new Variant({
                    dataType: DataType.Int32,
                    value: currentStatusValue
                })
        }
    });

    dp.on("change", (_oldValue, newValue) => {
        console.log(`[KNX CHANGE][${ip}] ${point.ga} (${point.dst}) ->`, newValue);
    });

    return {
        ga: point.ga,
        dst: point.dst,
        ip,
        signature: pointSignature(point),
        dp,
        opcNode,
        getStatusValue: () => currentStatusValue,
        setStatusValue: (v) => {
            currentStatusValue = v;
        }
    };
}

async function start() {
    const server = new OPCUAServer({
        port: OPC_UA_PORT,
        resourcePath: "/UA/KNXServer",
        buildInfo: {
            productName: "KNX-OPCUA-Bridge",
            buildNumber: "1",
            buildDate: new Date()
        }
    });

    await server.initialize();

    const addressSpace = server.engine.addressSpace;
    const namespace = addressSpace.getOwnNamespace();

    const rootDevice = namespace.addObject({
        organizedBy: addressSpace.rootFolder.objects,
        browseName: "KNX"
    });

    // key = ip
    const gatewayFolders = new Map();

    await server.start();

    console.log(`[OPCUA] Server started`);
    console.log(`[OPCUA] Endpoint: ${server.getEndpointUrl()}`);

    while (true) {
        try {
            const config = normalizeConfig(await loadConfig());
            const configRuntimeKeys = new Set();
            const configIps = new Set(config.gateways.map(g => g.IPRS));

            for (const gateway of config.gateways) {
                const ip = gateway.IPRS;
                const connection = await ensureKnxConnection(ip);

                if (!isKnxConnected(ip)) {
                    console.warn(`[KNX] Connection to ${ip} not ready, skipping cycle`);
                    continue;
                }

                let gatewayFolder = gatewayFolders.get(ip);
                if (!gatewayFolder) {
                    gatewayFolder = namespace.addObject({
                        componentOf: rootDevice,
                        browseName: sanitizeNodeName(ip)
                    });
                    gatewayFolders.set(ip, gatewayFolder);
                }

                const filePointsMap = new Map(
                    gateway.points.map((point) => [point.ga, point])
                );

                for (const [ga, point] of filePointsMap.entries()) {
                    const runtimeKey = makeRuntimeKey(ip, ga);
                    configRuntimeKeys.add(runtimeKey);

                    const existing = runtimePoints.get(runtimeKey);
                    const signature = pointSignature(point);

                    if (!existing) {
                        const runtimePoint = createRuntimePoint(
                            connection,
                            point,
                            ip,
                            namespace,
                            gatewayFolder
                        );

                        runtimePoints.set(runtimeKey, runtimePoint);
                        console.log(`[CFG] Added point ${ip} | ${ga} (${point.dst})`);
                    } else if (existing.signature !== signature) {
                        try {
                            addressSpace.deleteNode(existing.opcNode);
                        } catch {
                            // ignore
                        }

                        const runtimePoint = createRuntimePoint(
                            connection,
                            point,
                            ip,
                            namespace,
                            gatewayFolder
                        );

                        runtimePoints.set(runtimeKey, runtimePoint);
                        console.log(`[CFG] Updated point ${ip} | ${ga} (${point.dst})`);
                    }
                }
            }

            // מחיקה של נקודות שלא קיימות יותר בקובץ
            for (const [runtimeKey, item] of runtimePoints.entries()) {
                if (!configRuntimeKeys.has(runtimeKey)) {
                    try {
                        addressSpace.deleteNode(item.opcNode);
                    } catch {
                        // ignore
                    }

                    runtimePoints.delete(runtimeKey);
                    console.log(`[CFG] Removed point ${item.ip} | ${item.ga}`);
                }
            }

            // אפשר גם למחוק חיבורים ל-IP שכבר לא קיימים בקובץ
            for (const [ip, state] of knxConnections.entries()) {
                if (!configIps.has(ip)) {
                    try {
                        state.connection?.Disconnect();
                    } catch {
                        // ignore
                    }
                    knxConnections.delete(ip);
                    console.log(`[CFG] Removed gateway connection ${ip}`);
                }
            }

            console.log(`[MAIN] Starting polling cycle with ${runtimePoints.size} points...`);

            for (const item of runtimePoints.values()) {
                const result = await readDatapoint(item.ip, item);

                if (item.getStatusValue() !== result) {
                    item.setStatusValue(result);

                    item.opcNode.setValueFromSource(
                        {
                            dataType: DataType.Int32,
                            value: result
                        },
                        StatusCodes.Good
                    );

                    console.log(`[OPCUA] Updated ${item.ip} | ${item.ga} (${item.dst}) => ${result}`);
                }

                await delay(DELAY_BETWEEN_READS_MS);
            }

            console.log(`[MAIN] Polling cycle finished. Waiting ${CYCLE_DELAY_MS} ms...\n`);
        } catch (err) {
            console.error(`[MAIN] Error:`, err.message || err);
        }

        await delay(CYCLE_DELAY_MS);
    }
}

start().catch((err) => {
    console.error("Fatal error:", err);
});