import { getFirestore, FieldValue } from "firebase-admin/firestore";

export interface WorkAction {
  action: string;
  timestamp: number;
}

export interface AgentState {
  status: "idle" | "working";
  currentTask: string;
  startedAt: number;
  lastUpdate: number;
  actions: WorkAction[];
  telegramMessageId?: number;
}

const STATE_DOC = "work_in_progress";

export async function updateWorkStatus(task: string, action?: string) {
  const db = getFirestore();
  const stateRef = db.collection("agent_state").doc(STATE_DOC);
  const now = Date.now();

  const newAction: WorkAction | undefined = action
    ? { action, timestamp: now }
    : undefined;

  const update: Partial<AgentState> = {
    status: "working",
    currentTask: task,
    lastUpdate: now,
  };

  if (newAction) {
    const current = await stateRef.get();
    const currentData = current.data() as AgentState | undefined;
    update.actions = [...(currentData?.actions || []), newAction].slice(-20); // Keep last 20
  }

  if (!action) {
    update.startedAt = now;
    update.actions = [];
  }

  await stateRef.set(update, { merge: true });
}

export async function getWorkState(): Promise<AgentState | null> {
  const db = getFirestore();
  const stateRef = db.collection("agent_state").doc(STATE_DOC);
  const snapshot = await stateRef.get();
  return (snapshot.data() as AgentState) || null;
}

export async function setIdle() {
  const db = getFirestore();
  const stateRef = db.collection("agent_state").doc(STATE_DOC);
  await stateRef.set(
    {
      status: "idle",
      currentTask: "",
      actions: [],
      lastUpdate: Date.now(),
    },
    { merge: true }
  );
}

export async function saveMessageId(messageId: number) {
  const db = getFirestore();
  const stateRef = db.collection("agent_state").doc(STATE_DOC);
  await stateRef.set({
    telegramMessageId: messageId,
  }, { merge: true });
}
