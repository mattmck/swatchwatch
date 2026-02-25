import { QueueServiceClient } from "@azure/storage-queue";

const AZURE_STORAGE_CONNECTION_SETTING = "AzureWebJobsStorage";

export interface QueueStats {
  queueName: string;
  messageCount: number;
  timestamp: string;
}

export interface QueuePurgeResult {
  success: boolean;
  queueName: string;
  timestamp: string;
  error?: string;
}

async function getQueueServiceClient(): Promise<QueueServiceClient> {
  const connectionString = process.env[AZURE_STORAGE_CONNECTION_SETTING];
  if (!connectionString) {
    throw new Error(
      `${AZURE_STORAGE_CONNECTION_SETTING} environment variable not configured`
    );
  }
  return QueueServiceClient.fromConnectionString(connectionString);
}

export async function getQueueStats(queueName: string): Promise<QueueStats> {
  try {
    const serviceClient = await getQueueServiceClient();
    const queueClient = serviceClient.getQueueClient(queueName);
    await queueClient.createIfNotExists();

    const properties = await queueClient.getProperties();
    const messageCount = properties.approximateMessagesCount || 0;

    return {
      queueName,
      messageCount,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to get queue stats: ${message}`);
  }
}

export async function purgeQueue(queueName: string): Promise<QueuePurgeResult> {
  try {
    const serviceClient = await getQueueServiceClient();
    const queueClient = serviceClient.getQueueClient(queueName);
    await queueClient.createIfNotExists();

    await queueClient.clearMessages();

    return {
      success: true,
      queueName,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      queueName,
      timestamp: new Date().toISOString(),
      error: message,
    };
  }
}
