import { getFirestore } from "firebase-admin/firestore";
import * as dotenv from 'dotenv';
import { initializeApp, cert } from "firebase-admin/app";

dotenv.config();

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || "");
    initializeApp({
        credential: cert(serviceAccount)
    });
} catch (e) {
    console.error("Could not init firebase:", e);
}

async function run() {
    const db = getFirestore();
    const start = Date.now();
    const snap = await db.collection("memory_learned").get();
    const fetchTime = Date.now() - start;

    let totalData = 0;
    snap.docs.forEach(d => {
        const data = d.data();
        totalData += JSON.stringify(data).length;
    });

    console.log(`Found ${snap.size} learned facts.`);
    console.log(`Fetch time: ${fetchTime} ms.`);
    console.log(`Approximate size in JSON: ${(totalData / 1024).toFixed(2)} KB.`);

    if (snap.size > 0) {
        const sample = snap.docs[0].data();
        console.log(`Sample embedding length: ${sample.embedding ? sample.embedding.length : 'none'}`);
    }
}

run().catch(console.error);
