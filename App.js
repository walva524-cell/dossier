import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

const AV_KEY = process.env.EXPO_PUBLIC_ALPHA_VANTAGE_KEY;

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const getAvError = (json) =>
  json?.Note || json?.Information || json?.["Error Message"] || "";

const quotePrice = (json) => toNumber(json?.["Global Quote"]?.["05. price"]);

export default function App() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [btc, setBtc] = useState(null);
  const [oficial, setOficial] = useState(null);
  const [paralelo, setParalelo] = useState(null);
  const [actualizado, setActualizado] = useState("");

  const [oro, setOro] = useState(null); // proxy GLD
  const [plata, setPlata] = useState(null); // proxy SLV
  const [petroleo, setPetroleo] = useState(null); // WTI
  const [sp500, setSp500] = useState(null); // proxy SPY

  const cargarDatos = async () => {
  try {
    setLoading(true);
    setError("");

    // 1) Fuentes que casi siempre responden
    const [btcRes, oficialRes, paraleloRes] = await Promise.all([
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"),
      fetch("https://ve.dolarapi.com/v1/dolares/oficial"),
      fetch("https://ve.dolarapi.com/v1/dolares/paralelo"),
    ]);

    const [btcJson, oficialJson, paraleloJson] = await Promise.all([
      btcRes.json(),
      oficialRes.json(),
      paraleloRes.json(),
    ]);

    setBtc(toNumber(btcJson?.bitcoin?.usd));
    setOficial(toNumber(oficialJson?.promedio));
    setParalelo(toNumber(paraleloJson?.promedio));
    setActualizado(oficialJson?.fechaActualizacion ?? "");

    // 2) Alpha Vantage (puede limitar)
    if (!AV_KEY) {
      setError("Falta EXPO_PUBLIC_ALPHA_VANTAGE_KEY en .env");
      setOro(null);
      setPlata(null);
      setPetroleo(null);
      setSp500(null);
      return;
    }

    const [gldRes, slvRes, wtiRes, spyRes] = await Promise.all([
      fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=GLD&apikey=${AV_KEY}`),
      fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SLV&apikey=${AV_KEY}`),
      fetch(`https://www.alphavantage.co/query?function=WTI&interval=daily&apikey=${AV_KEY}`),
      fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SPY&apikey=${AV_KEY}`),
    ]);

    const [gldJson, slvJson, wtiJson, spyJson] = await Promise.all([
      gldRes.json(),
      slvRes.json(),
      wtiRes.json(),
      spyRes.json(),
    ]);

    const avErrors = [
      getAvError(gldJson),
      getAvError(slvJson),
      getAvError(wtiJson),
      getAvError(spyJson),
    ].filter(Boolean);

    setOro(quotePrice(gldJson));
    setPlata(quotePrice(slvJson));
    setSp500(quotePrice(spyJson));
    setPetroleo(toNumber(wtiJson?.data?.[0]?.value));

    if (avErrors.length) {
      setError("Alpha Vantage limitó algunas cotizaciones. Espera 60 segundos y pulsa Actualizar.");
    }
  } catch (e) {
    setError(e?.message || "No se pudieron cargar los datos.");
  } finally {
    setLoading(false);
  }
};


  useEffect(() => {
    cargarDatos();
  }, []);

  const money = (n) => (n !== null && n !== undefined ? `$${Number(n).toLocaleString()}` : "--");

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Dossier</Text>

      {loading ? <ActivityIndicator /> : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.card}><Text style={styles.label}>BTC (USD)</Text><Text style={styles.value}>{money(btc)}</Text></View>
      <View style={styles.card}><Text style={styles.label}>Oro (proxy GLD)</Text><Text style={styles.value}>{money(oro)}</Text></View>
      <View style={styles.card}><Text style={styles.label}>Plata (proxy SLV)</Text><Text style={styles.value}>{money(plata)}</Text></View>
      <View style={styles.card}><Text style={styles.label}>Petróleo WTI</Text><Text style={styles.value}>{money(petroleo)}</Text></View>
      <View style={styles.card}><Text style={styles.label}>S&P 500 (proxy SPY)</Text><Text style={styles.value}>{money(sp500)}</Text></View>
      <View style={styles.card}><Text style={styles.label}>Dólar Oficial</Text><Text style={styles.value}>{oficial ? `${oficial} Bs` : "--"}</Text></View>
      <View style={styles.card}><Text style={styles.label}>Dólar Paralelo</Text><Text style={styles.value}>{paralelo ? `${paralelo} Bs` : "--"}</Text></View>

      <Text style={styles.updated}>{actualizado ? `Actualizado: ${actualizado}` : ""}</Text>

      <Pressable style={styles.button} onPress={cargarDatos}>
        <Text style={styles.buttonText}>Actualizar</Text>
      </Pressable>

      <StatusBar style="auto" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: "#f5f7fb", padding: 16, justifyContent: "center", gap: 10 },
  title: { fontSize: 28, fontWeight: "700", textAlign: "center", marginBottom: 6 },
  card: { backgroundColor: "white", borderRadius: 12, padding: 12 },
  label: { fontSize: 14, color: "#5f6368" },
  value: { fontSize: 22, fontWeight: "700" },
  updated: { textAlign: "center", fontSize: 12, color: "#5f6368" },
  error: { color: "#b00020", textAlign: "center" },
  button: { backgroundColor: "#0b57d0", paddingVertical: 12, borderRadius: 10, alignItems: "center", marginTop: 6 },
  buttonText: { color: "white", fontWeight: "600" },
});
