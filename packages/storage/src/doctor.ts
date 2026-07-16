import net from "node:net";
import { defaultServiceEndpoints, type ServiceEndpoint } from "./config.js";

export interface ServiceCheck {
  endpoint: ServiceEndpoint;
  reachable: boolean;
  message: string;
}

export async function checkServices(endpoints = defaultServiceEndpoints): Promise<ServiceCheck[]> {
  return Promise.all(endpoints.map(checkService));
}

function checkService(endpoint: ServiceEndpoint): Promise<ServiceCheck> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({
        endpoint,
        reachable: false,
        message: `timeout connecting to ${endpoint.host}:${endpoint.port}`
      });
    }, 1000);

    socket.on("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve({
        endpoint,
        reachable: true,
        message: `reachable at ${endpoint.host}:${endpoint.port}`
      });
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        endpoint,
        reachable: false,
        message: error.message
      });
    });
  });
}

