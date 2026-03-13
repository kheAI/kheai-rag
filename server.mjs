import express from 'express';
import axios from 'axios';
import { create, insert, search, remove } from '@orama/orama';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const app = express();
const td = new TurndownService();
const KNOWLEDGE_DIR = './knowledge';
const LLAMA_API = process.env.LLAMA_API || 'http://192.168.0.166:8080/v1';
const API_KEY = process.env.API_KEY || 'local-pi-key';
const STOP_WORDS = new Set(['hello', 'hi', 'yo', 'hey', 'thanks', 'bye', 'ok', 'yes', 'no']);

app.use(express.json());
app.use(express.static('public'));

// --- 1. THE DATABASE (Orama) ---
const db = await create({
    schema: { text: 'string', source: 'string' }
});

// --- 2. THE WATCHDOG (Ingestion & Pruning) ---
await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });

chokidar.watch(KNOWLEDGE_DIR).on('all', async (event, filePath) => {
    if (event !== 'add' && event !== 'change') return;
    if (path.extname(filePath) !== '.md') return;

    const content = await fs.readFile(filePath, 'utf-8');
    
    // 🧹 Aggressive Filter: Remove instructional meta-data before it hits the DB
    const chunks = content.split(/\n\s*\n/).filter(c => {
        const t = c.toLowerCase();
        const isInstructional = t.includes("decision matrix") || t.includes("policy") || t.includes("answer strictly");
        return !isInstructional && t.trim().length > 30;
    });

    // Clear old data for this file before re-indexing (Optional but recommended)
    // You can just manually 'rm knowledge/*.md' and restart for a fresh start
    
    for (const chunk of chunks) {
        await insert(db, { text: chunk.trim(), source: path.basename(filePath) });
    }
    console.log(`✅ Clean Index: ${path.basename(filePath)} (${chunks.length} factual chunks)`);
});

// --- 3. THE SCRAPER (Web Sense) ---
app.post('/api/learn-url', async (req, res) => {
    try {
        const { url } = req.body;
        const { data: html } = await axios.get(url);
        const $ = cheerio.load(html);
        $('script, style, nav, footer').remove();
        
        const markdown = td.turndown($('article').html() || $('body').html());
        const filename = `${Date.now()}.md`;
        await fs.writeFile(path.join(KNOWLEDGE_DIR, filename), `# Source: ${url}\n\n${markdown}`);
        
        res.json({ message: "Knowledge acquired." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 4. KNOWLEDGE MANAGEMENT (The API) ---
app.get('/api/knowledge', async (req, res) => {
    try {
        const files = await fs.readdir(KNOWLEDGE_DIR);
        res.json({ files: files.filter(f => f.endsWith('.md')) });
    } catch (err) {
        res.status(500).json({ error: "Failed to list knowledge." });
    }
});

app.delete('/api/knowledge/:filename', async (req, res) => {
    try {
        await fs.unlink(path.join(KNOWLEDGE_DIR, req.params.filename)); 
        // The Watchdog 'unlink' event handles the DB purge automatically!
        res.json({ message: "Memory purged successfully." });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete file." });
    }
});

// --- 5. THE RAG CHAT (Logic Engine) ---
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    const lowerMsg = message.toLowerCase().trim();
    
    try {
        // 1. Identify "Social" vs "Technical"
        const isGreeting = STOP_WORDS.has(lowerMsg) || lowerMsg === "yo" || message.length < 4;
        
        if (isGreeting) {
            console.log(`💬 Chat Mode: ${message}`);
            const chatRes = await axios.post(`${LLAMA_API}/chat/completions`, {
                model: "qwen",
                messages: [{ role: "user", content: `You are Kai's local AI, kheAI. Say hi: ${message}` }],
                temperature: 0.8
            }, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
            return res.json({ answer: chatRes.data.choices[0].message.content });
        }

        // 2. Technical RAG Mode
        const cleanQuery = message.replace(/what is|tell me about|do you know|compare|who is/gi, '').trim();
        const sResult = await search(db, { 
            term: cleanQuery, 
            limit: 5,
            tolerance: 1
        });

        const context = sResult.hits.map(h => h.document.text).join('\n---\n');
        console.log(`🎯 RAG: Found ${sResult.count} chunks for "${cleanQuery}"`);

        // THE "MISSION" PROMPT
        const prompt = `### MISSION
Answer the User's question using ONLY the data in the DATA VAULT. 
If the information is missing, say "I don't have that data in my memory bank yet."

### DATA VAULT
${context || "NO DATA FOUND"}

### USER QUESTION
${message}

### YOUR RESPONSE:`;

        const aiRes = await axios.post(`${LLAMA_API}/chat/completions`, {
            model: "qwen",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.0,
            max_tokens: 200
        }, { headers: { 'Authorization': `Bearer ${API_KEY}` } });

        res.json({ answer: aiRes.data.choices[0].message.content, context });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Brain connection lost." });
    }
});

app.listen(3000, () => console.log('🚀 kheAI running on port 3000'));