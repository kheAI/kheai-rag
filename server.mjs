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
const LLAMA_API = process.env.LLAMA_API || 'http://192.168.0.166/:8080/v1';
const API_KEY = process.env.API_KEY || 'local-pi-key';

app.use(express.json());
app.use(express.static('public'));

// --- 1. THE DATABASE (Orama) ---
const db = await create({
    schema: { text: 'string', source: 'string' }
});

// --- 2. THE WATCHDOG (Ingestion & Pruning) ---
await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });

chokidar.watch(KNOWLEDGE_DIR).on('all', async (event, filePath) => {
    const fileName = path.basename(filePath);
    if (path.extname(filePath) !== '.md') return;

    if (event === 'add' || event === 'change') {
        const content = await fs.readFile(filePath, 'utf-8');
        const chunks = content.split('\n\n').filter(c => c.trim().length > 50);
        for (const chunk of chunks) {
            await insert(db, { text: chunk.trim(), source: fileName });
        }
        console.log(`✅ Indexed: ${fileName}`);
    } 
    else if (event === 'unlink') {
        // Find and purge deleted knowledge
        const allDocs = await search(db, { where: { source: fileName }, limit: 1000 });
        for (const hit of allDocs.hits) {
            await remove(db, hit.id);
        }
        console.log(`🗑️ Memory Purged: ${fileName}`);
    }
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
    try {
        const sResult = await search(db, { term: message, limit: 3 });
        const context = sResult.hits.map(h => h.document.text).join('\n---\n');
        
        const prompt = `CONTEXT:\n${context}\n\nUSER: ${message}\n\nINSTRUCTION: Answer strictly using context. If unknown, say RECOURSE.`;
        
        const aiRes = await axios.post(`${LLAMA_API}/chat/completions`, {
            model: "qwen3.5-0.8b",
            messages: [{ role: "system", content: "Logic engine. Concise." }, { role: "user", content: prompt }],
            temperature: 0.0
        }, { headers: { 'Authorization': `Bearer ${API_KEY}` } });

        res.json({ answer: aiRes.data.choices[0].message.content, context });
    } catch (err) {
        res.status(500).json({ error: "Brain connection lost." });
    }
});

app.listen(3000, () => console.log('🚀 kheAI running on port 3000'));