import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool } from "./db.js";

function generaCodiceBracciale() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; 
  let codice = "";
  for (let i = 0; i < 6; i++) {
    codice += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return codice;
}

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("src/public"));

app.get("/", (req, res) => {
  res.json({ status: "Server NFC Event System attivo ✅" });
});

app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore connessione DB" });
  }
});

// CREA UN NUOVO EVENTO
app.post("/eventi", async (req, res) => {
  try {
    let { nome, data_evento, accent_color, logo_url } = req.body;

    // colore di default se non specificato
    if (!accent_color) {
      accent_color = "#0a84ff";
    }

    const result = await pool.query(
      "INSERT INTO eventi (nome, data_evento, accent_color, logo_url) VALUES ($1, $2, $3, $4) RETURNING *",
      [nome, data_evento, accent_color, logo_url || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore creazione evento" });
  }
});

// LISTA PRODOTTI PER EVENTO
app.get("/prodotti", async (req, res) => {
  try {
    const { evento_id } = req.query;

    if (!evento_id) {
      return res.status(400).json({ error: "evento_id mancante" });
    }

    const result = await pool.query(
      "SELECT id, nome, prezzo FROM prodotti WHERE evento_id = $1",
      [evento_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore lettura prodotti" });
  }
});

// REGISTRA UN BRACCIALE NFC (evita doppioni per stesso UID + evento)
app.post("/bracciali", async (req, res) => {
  try {
    const { uid, evento_id } = req.body;

    if (!evento_id) {
      return res.status(400).json({ error: "evento_id mancante" });
    }

    if (!uid) {
      return res.status(400).json({ error: "UID NFC mancante" });
    }

    // 1) Controllo se esiste già un bracciale con questo UID per questo evento
    const esistente = await pool.query(
      "SELECT * FROM bracciali WHERE uid = $1 AND evento_id = $2",
      [uid, evento_id]
    );

    if (esistente.rows.length > 0) {
      // Già registrato → ritorno quello, NON ne creo un altro
      return res.json({
        ...esistente.rows[0],
        gia_registrato: true
      });
    }

    // 2) Genero un codice a 6 caratteri univoco
    let codice;
    let esiste = true;

    while (esiste) {
      codice = generaCodiceBracciale();
      const check = await pool.query(
        "SELECT id FROM bracciali WHERE codice = $1",
        [codice]
      );
      esiste = check.rows.length > 0;
    }

    // 3) Inserisco nuovo bracciale
    const result = await pool.query(
      "INSERT INTO bracciali (uid, evento_id, codice) VALUES ($1, $2, $3) RETURNING *",
      [uid, evento_id, codice]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    // nel caso il vincolo UNIQUE scatti comunque
    if (err.code === "23505") {
      return res
        .status(400)
        .json({ error: "Questo bracciale è già registrato per l'evento." });
    }
    res.status(500).json({ error: "Errore registrazione bracciale" });
  }
});

// CARICA PRODOTTI SUL BRACCIALE (CASSA)
app.post("/carica", async (req, res) => {
  try {
    const { bracciale_id, prodotto_id, quantita, operatore_id } = req.body;

    console.log("CARICA richiesta:", {
      bracciale_id,
      prodotto_id,
      quantita,
      operatore_id
    });

    if (!bracciale_id || !prodotto_id || !quantita) {
      return res
        .status(400)
        .json({ error: "Dati mancanti per il carico prodotto" });
    }

    // controlliamo se esiste già un record crediti
    const check = await pool.query(
      "SELECT * FROM crediti WHERE bracciale_id = $1 AND prodotto_id = $2",
      [bracciale_id, prodotto_id]
    );

    if (check.rows.length === 0) {
      // non esiste → lo creiamo
      await pool.query(
        "INSERT INTO crediti (bracciale_id, prodotto_id, quantita) VALUES ($1, $2, $3)",
        [bracciale_id, prodotto_id, quantita]
      );
    } else {
      // esiste → aggiorniamo
      await pool.query(
        "UPDATE crediti SET quantita = quantita + $1 WHERE bracciale_id = $2 AND prodotto_id = $3",
        [quantita, bracciale_id, prodotto_id]
      );
    }

    // log transazione (carico)
    const logRes = await pool.query(
      "INSERT INTO transazioni (bracciale_id, prodotto_id, tipo, quantita, operatore_id) VALUES ($1, $2, 'carico', $3, $4) RETURNING *",
      [bracciale_id, prodotto_id, quantita, operatore_id || null]
    );

    console.log("CARICA ok, transazione:", logRes.rows[0]);

    res.json({ status: "Credito caricato correttamente ✅" });
  } catch (err) {
    console.error("ERRORE /carica:", err);
    res.status(500).json({ error: "Errore carico credito" });
  }
});

// LEGGI SALDO BRACCIALE (BAR)
app.get("/saldo/:bracciale_id", async (req, res) => {
  try {
    const { bracciale_id } = req.params;

    const result = await pool.query(
      `SELECT p.id AS prodotto_id, p.nome, c.quantita 
      FROM crediti c
      JOIN prodotti p ON c.prodotto_id = p.id
      WHERE c.bracciale_id = $1`,
      [bracciale_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore lettura saldo" });
  }
});

// ✅ SCARICA UN PRODOTTO DAL BRACCIALE (BAR) - CON LOG
app.post("/scarica", async (req, res) => {
  try {
    const { bracciale_id, prodotto_id, operatore_id } = req.body;

    if (!bracciale_id || !prodotto_id) {
      return res.status(400).json({ error: "Dati mancanti" });
    }

    // 1️⃣ Controllo quantità attuale
    const check = await pool.query(
      "SELECT quantita FROM crediti WHERE bracciale_id = $1 AND prodotto_id = $2",
      [bracciale_id, prodotto_id]
    );

    console.log("CHECK CREDITO:", check.rows);

    if (check.rows.length === 0) {
      return res
        .status(400)
        .json({ error: "Nessun credito per questo prodotto ❌" });
    }

    if (check.rows[0].quantita <= 0) {
      return res.status(400).json({ error: "Credito esaurito ❌" });
    }

    // 2️⃣ SCALO DAVVERO DAL DB (QUI METTIAMO I LOG)
    console.log("SCARICO:", bracciale_id, prodotto_id);

    const update = await pool.query(
      "UPDATE crediti SET quantita = quantita - 1 WHERE bracciale_id = $1 AND prodotto_id = $2 RETURNING *",
      [bracciale_id, prodotto_id]
    );

    console.log("RISULTATO UPDATE:", update.rows);

    // 3️⃣ LOG TRANSAZIONE
    await pool.query(
      "INSERT INTO transazioni (bracciale_id, prodotto_id, tipo, quantita, operatore_id) VALUES ($1, $2, 'scarico', 1, $3)",
      [bracciale_id, prodotto_id, operatore_id || null]
    );

    res.json({
      status: "Prodotto scaricato ✅",
      nuovo_saldo: update.rows[0]?.quantita
    });
  } catch (err) {
    console.error("ERRORE SCARICO:", err);
    res.status(500).json({ error: "Errore scarico prodotto" });
  }
});

// CREA UN ORDINE (dal web shop cliente)
app.post("/ordini", async (req, res) => {
  try {
    const { evento_id, prodotti } = req.body;
    // prodotti = [{ prodotto_id: 1, quantita: 2 }, ...]

    // crea ordine
    const ordineResult = await pool.query(
      "INSERT INTO ordini (evento_id) VALUES ($1) RETURNING *",
      [evento_id]
    );

    const ordine = ordineResult.rows[0];

    // inserisci righe ordine_prodotti
    for (const p of prodotti) {
      await pool.query(
        "INSERT INTO ordine_prodotti (ordine_id, prodotto_id, quantita) VALUES ($1, $2, $3)",
        [ordine.id, p.prodotto_id, p.quantita]
      );
    }

    res.json({
      ordine_id: ordine.id,
      messaggio: "Ordine creato, mostra questo codice in cassa ✅"
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore creazione ordine" });
  }
});

// LEGGI DETTAGLIO ORDINE
app.get("/ordini/:ordine_id", async (req, res) => {
  try {
    const { ordine_id } = req.params;

    const ordine = await pool.query(
      "SELECT * FROM ordini WHERE id = $1",
      [ordine_id]
    );

    if (ordine.rows.length === 0) {
      return res.status(404).json({ error: "Ordine non trovato" });
    }

    const righe = await pool.query(
      `SELECT p.nome, op.prodotto_id, op.quantita
       FROM ordine_prodotti op
       JOIN prodotti p ON op.prodotto_id = p.id
       WHERE op.ordine_id = $1`,
      [ordine_id]
    );

    res.json({
      ordine: ordine.rows[0],
      prodotti: righe.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore lettura ordine" });
  }
});

// APPLICA UN ORDINE A UN BRACCIALE (CASSA AUTOMATICA)
app.post("/applica-ordine", async (req, res) => {
  try {
    const { ordine_id, bracciale_id } = req.body;

    // 1. Controllo ordine
    const ordine = await pool.query(
      "SELECT * FROM ordini WHERE id = $1",
      [ordine_id]
    );

    if (ordine.rows.length === 0) {
      return res.status(404).json({ error: "Ordine non trovato" });
    }

    if (ordine.rows[0].stato === "usato") {
      return res.status(400).json({ error: "Ordine già utilizzato ❌" });
    }

    // 2. Prendo i prodotti dell'ordine
    const righe = await pool.query(
      "SELECT prodotto_id, quantita FROM ordine_prodotti WHERE ordine_id = $1",
      [ordine_id]
    );

    // 3. Carico i prodotti sul bracciale
    for (const riga of righe.rows) {
      const check = await pool.query(
        "SELECT * FROM crediti WHERE bracciale_id = $1 AND prodotto_id = $2",
        [bracciale_id, riga.prodotto_id]
      );

      if (check.rows.length === 0) {
        await pool.query(
          "INSERT INTO crediti (bracciale_id, prodotto_id, quantita) VALUES ($1, $2, $3)",
          [bracciale_id, riga.prodotto_id, riga.quantita]
        );
      } else {
        await pool.query(
          "UPDATE crediti SET quantita = quantita + $1 WHERE bracciale_id = $2 AND prodotto_id = $3",
          [riga.quantita, bracciale_id, riga.prodotto_id]
        );
      }
    }

    // 4. Segno ordine come usato
    await pool.query(
      "UPDATE ordini SET stato = 'usato' WHERE id = $1",
      [ordine_id]
    );

    res.json({ status: "Ordine applicato al bracciale ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore applicazione ordine" });
  }
});

// ✅ TROVA BRACCIALE PER CODICE + EVENTO
app.get("/bracciali/codice/:codice", async (req, res) => {
  try {
    const { codice } = req.params;
    const { evento_id } = req.query;

    if (!evento_id) {
      return res.status(400).json({ error: "evento_id mancante" });
    }

    const result = await pool.query(
      "SELECT * FROM bracciali WHERE codice = $1 AND evento_id = $2",
      [codice.toUpperCase(), evento_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Bracciale non trovato per questo evento" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore ricerca bracciale" });
  }
});

// RICARICA DIRETTAMENTE UN BRACCIALE DAL CODICE (USATO DALLO SHOP CLIENTE)
app.post("/ricarica-diretta", async (req, res) => {
  try {
    const { codice, prodotti, evento_id } = req.body;

    if (!evento_id) {
      return res.status(400).json({ error: "evento_id mancante" });
    }

    if (!codice) {
      return res.status(400).json({ error: "Codice bracciale mancante" });
    }

    if (!Array.isArray(prodotti) || prodotti.length === 0) {
      return res.status(400).json({ error: "Nessun prodotto selezionato" });
    }

    const braccialeRes = await pool.query(
      "SELECT id FROM bracciali WHERE codice = $1 AND evento_id = $2",
      [codice.toUpperCase(), evento_id]
    );

    if (braccialeRes.rows.length === 0) {
      return res.status(404).json({ error: "Bracciale non trovato per questo evento" });
    }

    const bracciale_id = braccialeRes.rows[0].id;

    // Carico i prodotti sul bracciale
    for (const p of prodotti) {
      const { prodotto_id, quantita } = p;

      const check = await pool.query(
        "SELECT * FROM crediti WHERE bracciale_id = $1 AND prodotto_id = $2",
        [bracciale_id, prodotto_id]
      );

      if (check.rows.length === 0) {
        await pool.query(
          "INSERT INTO crediti (bracciale_id, prodotto_id, quantita) VALUES ($1, $2, $3)",
          [bracciale_id, prodotto_id, quantita]
        );
      } else {
        await pool.query(
          "UPDATE crediti SET quantita = quantita + $1 WHERE bracciale_id = $2 AND prodotto_id = $3",
          [quantita, bracciale_id, prodotto_id]
        );
      }

      await pool.query(
        "INSERT INTO transazioni (bracciale_id, prodotto_id, tipo, quantita, operatore_id) VALUES ($1, $2, 'carico_web', $3, NULL)",
        [bracciale_id, p.prodotto_id, p.quantita]
      );
    }

    res.json({ status: "Bracciale ricaricato correttamente ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore ricarica diretta" });
  }
});

// TROVA O REGISTRA AUTOMATICAMENTE BRACCIALE DA UID (MULTI-EVENTO)
app.get("/bracciali/uid/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const evento_id = req.query.evento_id;

    if (!evento_id) {
      return res.status(400).json({ error: "evento_id mancante" });
    }

    // 1) CERCO SE ESISTE GIÀ
    const esistente = await pool.query(
      "SELECT * FROM bracciali WHERE uid = $1 AND evento_id = $2",
      [uid, evento_id]
    );

    if (esistente.rows.length > 0) {
      return res.json(esistente.rows[0]);
    }

    // 2) SE NON ESISTE → GENERO CODICE UNICO
    let codice;
    let esiste = true;

    while (esiste) {
      codice = generaCodiceBracciale();
      const check = await pool.query(
        "SELECT id FROM bracciali WHERE codice = $1",
        [codice]
      );
      esiste = check.rows.length > 0;
    }

    // 3) CREO NUOVO BRACCIALE CON UID + CODICE
    const nuovo = await pool.query(
      "INSERT INTO bracciali (uid, evento_id, codice) VALUES ($1, $2, $3) RETURNING *",
      [uid, evento_id, codice]
    );

    res.json(nuovo.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore gestione UID" });
  }
});

// LISTA EVENTI
app.get("/eventi", async (req, res) => {
  try {
    const { solo_pubblici } = req.query;

    let query = "SELECT * FROM eventi";
    let params = [];

    if (solo_pubblici === "true") {
      query += " WHERE pubblico = true";
    }

    query += " ORDER BY id DESC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore lettura eventi" });
  }
});

// LOGIN OPERATORE
app.post("/login", async (req, res) => {
  try {
    const { nome, password, evento_id } = req.body;

    const result = await pool.query(
      "SELECT id, nome, ruolo, evento_id FROM operatori WHERE nome = $1 AND password = $2 AND evento_id = $3",
      [nome, password, evento_id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Credenziali non valide" });
    }

    res.json({
      status: "Login riuscito ✅",
      operatore: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore login" });
  }
});

// INCASSO TOTALE EVENTO
app.get("/dashboard/incasso/:evento_id", async (req, res) => {
  try {
    const { evento_id } = req.params;

    const result = await pool.query(
      `SELECT 
        SUM(t.quantita * p.prezzo) AS totale
       FROM transazioni t
       JOIN prodotti p ON t.prodotto_id = p.id
       JOIN bracciali b ON t.bracciale_id = b.id
       WHERE 
         b.evento_id = $1
         AND t.tipo IN ('carico', 'carico_web')`,
      [evento_id]
    );

    res.json({ totale: result.rows[0].totale || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore calcolo incasso" });
  }
});

// VENDITE PER PRODOTTO
app.get("/dashboard/prodotti/:evento_id", async (req, res) => {
  try {
    const { evento_id } = req.params;

    const result = await pool.query(
      `SELECT 
         p.nome,
         SUM(t.quantita) AS quantita,
         SUM(t.quantita * p.prezzo) AS fatturato
       FROM transazioni t
       JOIN prodotti p ON t.prodotto_id = p.id
       JOIN bracciali b ON t.bracciale_id = b.id
       WHERE 
         b.evento_id = $1
         AND t.tipo IN ('carico', 'carico_web')
       GROUP BY p.nome
       ORDER BY fatturato DESC`,
      [evento_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore dashboard prodotti" });
  }
});

// LOG TRANSAZIONI EVENTO
app.get("/dashboard/log/:evento_id", async (req, res) => {
  try {
    const { evento_id } = req.params;

    const result = await pool.query(
      `SELECT 
        t.id,
        t.tipo,
        t.quantita,
        p.nome AS prodotto,
        t.data
       FROM transazioni t
       JOIN prodotti p ON t.prodotto_id = p.id
       JOIN bracciali b ON t.bracciale_id = b.id
       WHERE b.evento_id = $1
       ORDER BY t.data DESC`,
      [evento_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore log" });
  }
});

// VENDITE / MOVIMENTI PER OPERATORE
app.get("/dashboard/operatori/:evento_id", async (req, res) => {
  try {
    const { evento_id } = req.params;

    const result = await pool.query(
      `SELECT
         o.id,
         o.nome,
         o.ruolo,
         COUNT(*) FILTER (WHERE t.tipo IN ('carico','carico_web')) AS num_carichi,
         COALESCE(
           SUM(
             CASE 
               WHEN t.tipo IN ('carico','carico_web') 
                 THEN t.quantita * p.prezzo
               ELSE 0
             END
           ), 0
         ) AS valore_caricato,
         COUNT(*) FILTER (WHERE t.tipo = 'scarico') AS num_scarichi
       FROM transazioni t
       JOIN bracciali b ON t.bracciale_id = b.id
       JOIN prodotti p ON t.prodotto_id = p.id
       LEFT JOIN operatori o ON t.operatore_id = o.id
       WHERE b.evento_id = $1
         AND o.id IS NOT NULL
       GROUP BY o.id, o.nome, o.ruolo
       ORDER BY valore_caricato DESC`,
      [evento_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore report operatori" });
  }
});

// EXPORT CSV TRANSIZIONI EVENTO
app.get("/dashboard/log-csv/:evento_id", async (req, res) => {
  try {
    const { evento_id } = req.params;

    const result = await pool.query(
      `SELECT 
         t.id,
         t.data,
         t.tipo,
         t.quantita,
         p.nome AS prodotto,
         p.prezzo AS prezzo_centesimi,
         b.id AS bracciale_id,
         o.nome AS operatore,
         o.ruolo AS ruolo_operatore
       FROM transazioni t
       JOIN prodotti p  ON t.prodotto_id = p.id
       JOIN bracciali b ON t.bracciale_id = b.id
       LEFT JOIN operatori o ON t.operatore_id = o.id
       WHERE b.evento_id = $1
       ORDER BY t.data ASC`,
      [evento_id]
    );

    const headers = [
      "id",
      "data",
      "tipo",
      "quantita",
      "prodotto",
      "prezzo_centesimi",
      "bracciale_id",
      "operatore",
      "ruolo_operatore"
    ];

    let csv = headers.join(";") + "\n";

    for (const row of result.rows) {
      const values = headers.map((h) => {
        let v = row[h];
        if (v === null || v === undefined) v = "";
        return String(v).replace(/;/g, ","); // evita di rompere il CSV
      });
      csv += values.join(";") + "\n";
    }

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="transazioni_evento_${evento_id}.csv"`
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore export CSV" });
  }
});

//CREAZIONE OPERATORE
app.post("/operatori", async (req, res) => {
  const { nome, password, ruolo, evento_id } = req.body;

  const result = await pool.query(
    "INSERT INTO operatori (nome, password, ruolo, evento_id) VALUES ($1,$2,$3,$4) RETURNING *",
    [nome, password, ruolo, evento_id]
  );

  res.json(result.rows[0]);
});

//LISTA BRACCIALI PER EVENTO
app.get("/bracciali", async (req, res) => {
  const { evento_id } = req.query;

  const result = await pool.query(
    "SELECT * FROM bracciali WHERE evento_id = $1",
    [evento_id]
  );

  res.json(result.rows);
});

// SALVA/AGGIORNA INSTAGRAM SU BRACCIALE
app.post("/bracciali/:id/instagram", async (req, res) => {
  try {
    const { id } = req.params;
    let { instagram } = req.body;

    if (!instagram) {
      return res.status(400).json({ error: "instagram mancante" });
    }

    instagram = instagram.trim();

    // normalizza: accetta "@nome" o "nome"
    if (instagram.startsWith("@")) instagram = instagram.slice(1);

    // super base: solo caratteri consentiti IG
    if (!/^[A-Za-z0-9._]{1,30}$/.test(instagram)) {
      return res.status(400).json({ error: "Username Instagram non valido" });
    }

    const result = await pool.query(
      "UPDATE bracciali SET instagram = $1 WHERE id = $2 RETURNING *",
      [instagram, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Bracciale non trovato" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore salvataggio instagram" });
  }
});

//ELIMINA EVENTO
app.delete("/eventi/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query("DELETE FROM eventi WHERE id = $1", [id]);

    res.json({ status: "Evento eliminato ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore eliminazione evento" });
  }
});

//ELIMINA PRODOTTO
app.delete("/prodotti/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query("DELETE FROM prodotti WHERE id = $1", [id]);

    res.json({ status: "Prodotto eliminato ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore eliminazione prodotto" });
  }
});

//ELIMINA OPERATORE
app.delete("/operatori/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query("DELETE FROM operatori WHERE id = $1", [id]);

    res.json({ status: "Operatore eliminato ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore eliminazione operatore" });
  }
});

//ELIMINA BRACCIALE
app.delete("/bracciali/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query("DELETE FROM bracciali WHERE id = $1", [id]);

    res.json({ status: "Bracciale eliminato ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore eliminazione bracciale" });
  }
});

// LISTA OPERATORI PER EVENTO
app.get("/operatori", async (req, res) => {
  try {
    const { evento_id } = req.query;

    if (!evento_id) {
      return res.status(400).json({ error: "evento_id mancante" });
    }

    const result = await pool.query(
      "SELECT * FROM operatori WHERE evento_id = $1 ORDER BY id",
      [evento_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore lettura operatori" });
  }
});

// CREA PRODOTTO (ADMIN)
app.post("/prodotti", async (req, res) => {
  try {
    const { nome, prezzo, evento_id } = req.body;

    if (!nome || !prezzo || !evento_id) {
      return res.status(400).json({ error: "Dati prodotto mancanti" });
    }

    const result = await pool.query(
      "INSERT INTO prodotti (nome, prezzo, evento_id) VALUES ($1, $2, $3) RETURNING *",
      [nome, prezzo, evento_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("ERRORE CREAZIONE PRODOTTO:", err);
    res.status(500).json({ error: "Errore creazione prodotto" });
  }
});

// 🔄 RESET COMPLETO EVENTO (CREDITI + TRANSAZIONI + ORDINI + BRACCIALI)
app.post("/reset-evento/:evento_id", async (req, res) => {
  try {
    const { evento_id } = req.params;

    // 1️⃣ Recupero tutti i bracciali dell'evento
    const bracciali = await pool.query(
      "SELECT id FROM bracciali WHERE evento_id = $1",
      [evento_id]
    );

    // 2️⃣ Cancello tutti i crediti di quei bracciali
    for (const b of bracciali.rows) {
      await pool.query(
        "DELETE FROM crediti WHERE bracciale_id = $1",
        [b.id]
      );
    }

    // 3️⃣ Cancello tutte le transazioni dell'evento
    await pool.query(
      `DELETE FROM transazioni 
       USING bracciali 
       WHERE transazioni.bracciale_id = bracciali.id 
       AND bracciali.evento_id = $1`,
      [evento_id]
    );

    // 4️⃣ Cancello tutti gli ordini dell'evento (shop)
    await pool.query(
      "DELETE FROM ordini WHERE evento_id = $1",
      [evento_id]
    );

    // 5️⃣ Cancello tutti i bracciali dell'evento
    await pool.query(
      "DELETE FROM bracciali WHERE evento_id = $1",
      [evento_id]
    );

    res.json({ status: "🔄 Evento resettato completamente ✅" });
  } catch (err) {
    console.error("ERRORE RESET EVENTO:", err);
    res.status(500).json({ error: "Errore reset evento" });
  }
});

// 📤 EXPORT CSV COMPLETO DELL'EVENTO (PER EXCEL)
app.get("/export/evento/:evento_id", async (req, res) => {
  try {
    const { evento_id } = req.params;

    // prendiamo tutte le transazioni dell'evento
    const result = await pool.query(
      `SELECT 
         t.data,
         t.tipo,
         b.codice AS bracciale_codice,
         p.nome AS prodotto,
         t.quantita,
         p.prezzo,
         (t.quantita * p.prezzo) AS totale_cent
       FROM transazioni t
       JOIN bracciali b ON t.bracciale_id = b.id
       JOIN prodotti p ON t.prodotto_id = p.id
       WHERE b.evento_id = $1
       ORDER BY t.data ASC`,
      [evento_id]
    );

    // intestazione CSV
    let csv = "data,tipo,bracciale_codice,prodotto,quantita,prezzo_cent,totale_cent,totale_euro\n";

    // righe
    for (const row of result.rows) {
      const totaleEuro = (row.totale_cent || 0) / 100;
      csv += [
        row.data?.toISOString?.() || row.data,
        row.tipo,
        row.bracciale_codice || "",
        row.prodotto,
        row.quantita,
        row.prezzo,
        row.totale_cent,
        totaleEuro.toFixed(2).replace(".", ",") // formato europeo
      ]
        .map((v) => (v !== null && v !== undefined ? String(v) : ""))
        .join(",") + "\n";
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="evento_${evento_id}_export.csv"`
    );

    res.send(csv);
  } catch (err) {
    console.error("ERRORE EXPORT EVENTO:", err);
    res.status(500).json({ error: "Errore export evento" });
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server avviato sulla porta", PORT);
});

// ✅ TOGGLE VISIBILITÀ EVENTO (PUBBLICO / NASCOSTO)
app.post("/eventi/:id/pubblico", async (req, res) => {
  try {
    const { id } = req.params;
    const { pubblico } = req.body;

    await pool.query(
      "UPDATE eventi SET pubblico = $1 WHERE id = $2",
      [pubblico, id]
    );

    res.json({ status: "Visibilità evento aggiornata ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore aggiornamento evento" });
  }
});
