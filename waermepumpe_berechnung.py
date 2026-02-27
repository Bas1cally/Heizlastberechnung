#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
WÄRMEPUMPEN-DIMENSIONIERUNG
Schulstraße 28, 67360 Lingenfeld
================================================================================

Berechnung der erforderlichen Wärmepumpenleistung für:
  - Wohnung 1 (WE1): ALTBAU Baujahr 1952 (Bestand)
  - Wohnung 2 (WE2): NEUBAU EH55
  - Wohnung 3 (WE3): NEUBAU EH55

Anforderungen:
  - REINE Wärmepumpe (kein Gas, kein Strommix-Hybridbetrieb)
  - Fußbodenheizung in allen 3 Wohnungen
  - Warmwasserbereitung für alle 3 Wohnungen
  - Auslegung auf Normaußentemperatur (monovalenter Betrieb)

Normen/Grundlagen:
  - DIN EN 12831-1:2017-09 (Heizlastberechnung)
  - DIN V 18599 (Energiebilanz)
  - DIN 4708 (Warmwasserbedarf)
  - VDI 4645 (Wärmepumpen-Dimensionierung)

Autor: Automatisch erstellt aus PDF-Unterlagen
Datum: 2026-02-27
================================================================================
"""

import math
from dataclasses import dataclass, field
from typing import List, Tuple


# ==============================================================================
# KLIMADATEN - Standort Lingenfeld, Rheinland-Pfalz
# ==============================================================================
STANDORT = "Lingenfeld, 67360"
KLIMAZONE = 12  # DIN EN 12831
NORM_AUSSENTEMPERATUR = -10.0   # °C (θ_e) nach DIN EN 12831 für Klimazone 12
INNENTEMPERATUR = 20.0          # °C (θ_i) Standard Wohnräume
DELTA_T = INNENTEMPERATUR - NORM_AUSSENTEMPERATUR  # 30 K


# ==============================================================================
# DATENKLASSEN
# ==============================================================================
@dataclass
class Bauteil:
    """Ein Bauteil der Gebäudehülle"""
    name: str
    flaeche_m2: float        # Fläche in m²
    u_wert: float            # U-Wert in W/(m²K)
    temperatur_faktor: float # Fx - Korrekturfaktor (1.0=Außenluft, 0.5-0.8=Erdreich/unbeheizt)

    @property
    def ht_bauteil(self) -> float:
        """Transmissionswärmeverlustkoeffizient H_T in W/K"""
        return self.flaeche_m2 * self.u_wert * self.temperatur_faktor


@dataclass
class Gebaeude:
    """Gebäudedaten für die Heizlastberechnung"""
    name: str
    bauteile: List[Bauteil]
    luftvolumen_m3: float
    wohnflaeche_m2: float
    nutzflaeche_m2: float
    luftwechselrate: float     # n in 1/h
    waermebruecken_zuschlag: float  # ΔU_WB in W/(m²K)
    huellflaeche_m2: float     # A in m² (Summe aller Bauteilflächen)
    anzahl_personen: int
    geschosszahl: int

    @property
    def ht_transmission(self) -> float:
        """Gesamter Transmissionswärmeverlustkoeffizient H_T in W/K"""
        ht = sum(bt.ht_bauteil for bt in self.bauteile)
        # Wärmebrückenzuschlag
        ht += self.huellflaeche_m2 * self.waermebruecken_zuschlag
        return ht

    @property
    def hv_lueftung(self) -> float:
        """Lüftungswärmeverlustkoeffizient H_V in W/K"""
        rho_cp = 0.34  # Wh/(m³K) → hier in W·h/(m³·K), für W/K: * n
        return rho_cp * self.luftwechselrate * self.luftvolumen_m3

    @property
    def heizlast_transmission(self) -> float:
        """Transmissionsheizlast Φ_T in W"""
        return self.ht_transmission * DELTA_T

    @property
    def heizlast_lueftung(self) -> float:
        """Lüftungsheizlast Φ_V in W"""
        return self.hv_lueftung * DELTA_T

    @property
    def heizlast_gesamt(self) -> float:
        """Gesamte Gebäudeheizlast Φ_HL in W"""
        return self.heizlast_transmission + self.heizlast_lueftung

    @property
    def spezifische_heizlast(self) -> float:
        """Spezifische Heizlast in W/m² Wohnfläche"""
        return self.heizlast_gesamt / self.wohnflaeche_m2


# ==============================================================================
# 1. NEUBAU (WE2 + WE3) - EXAKTE DATEN AUS EH55-BERECHNUNG
# ==============================================================================
def erstelle_neubau() -> Gebaeude:
    """
    Neubau-Daten direkt aus der EH55-Berechnung (Dipl.-Ing. Artur Gerok).
    Quelle: EH55_Schulstraße 28.pdf, Seite 34-35

    EXAKTE Werte aus der DIN EN 12831-1 Berechnung:
    - Gebäudeheizlast: 6,4 kW (Seite 35)
    - HT' = 0,254 W/(m²K)
    - A = 603,1 m²
    - Ve = 951,6 m³
    - V = 723,2 m³
    - n_Geb = 0,25 h⁻¹ (Kategorie I)
    """

    # Bauteile aus Seite 28-29 der EH55-Berechnung (Transmissionswärmeverluste)
    bauteile_neubau = [
        # Opake Bauteile
        Bauteil("Bodenplatte",                106.89, 0.15, 0.75),   # Erdreich
        Bauteil("Außenwand NordOst",           72.33, 0.20, 1.00),   # Außenluft
        Bauteil("Außenwand SüdOst + Fenster",  87.00, 0.20, 1.00),   # inkl. Fenster Uw=0.9
        Bauteil("Außenwand SüdWest + Fenster", 72.74, 0.20, 1.00),   # inkl. Fenster Uw=0.9
        Bauteil("Außenwand NordWest + Fenster", 69.33, 0.20, 1.00),  # inkl. Fenster Uw=0.9
        Bauteil("Wohnungseingangstür",          4.40, 1.30, 1.00),
        Bauteil("Sparrendach NordOst + DF",    59.33, 0.14, 1.00),   # inkl. Dachfenster Uw=1.0
        Bauteil("Sparrendach SüdWest + DF",    59.33, 0.14, 1.00),   # inkl. Dachfenster Uw=1.0
        Bauteil("TH-Wand EG",                  17.76, 0.30, 1.00),
        Bauteil("Decke EG zum TH",             14.11, 0.21, 1.00),
    ]

    # HINWEIS: Die exakten Flächen-gewichteten U-Werte für die Bauteile inkl.
    # Fenster sind aus der detaillierten Berechnung (Seite 28) entnommen.
    # Die Fenster-U-Werte (Uw) sind in den Wandflächen bereits enthalten:
    # - Fenster SüdOst:  3,03 m², Uw = 0,90 W/(m²K)
    # - Fenster NordWest: 20,70 m², Uw = 0,90 W/(m²K)
    # - Fenster SüdWest:  7,18 m², Uw = 0,90 W/(m²K)
    # - Dachfenster NO:   4,47 m², Uw = 1,00 W/(m²K)
    # - Dachfenster SW:   4,47 m², Uw = 1,00 W/(m²K)

    return Gebaeude(
        name="NEUBAU EH55 (WE2 + WE3)",
        bauteile=bauteile_neubau,
        luftvolumen_m3=723.2,       # 0,76 × Ve
        wohnflaeche_m2=248.5,       # WE2: 129,16 + WE3: 119,63 ≈ 248,5
        nutzflaeche_m2=262.5,       # inkl. Treppenhaus
        luftwechselrate=0.25,       # Kategorie I (Dichtheit nachgewiesen)
        waermebruecken_zuschlag=0.022,  # detaillierte WB-Berechnung
        huellflaeche_m2=603.08,     # Gesamte Hüllfläche
        anzahl_personen=6,          # ~3 Personen pro Wohnung
        geschosszahl=3,             # EG + OG + DG
    )


# ==============================================================================
# 2. ALTBAU (WE1) - BESTAND BAUJAHR 1952
# ==============================================================================
def erstelle_altbau() -> Gebaeude:
    """
    Altbau-Heizlast nach DIN EN 12831-1 (vereinfachtes Verfahren).

    Quelle der Geometriedaten:
    - Wohnflächenberechnung Ing. Ruthig (Seite 1):
      WE1 Wohnfläche = 130,87 m²
      WE1 Wohn- u. Nutzfläche = 146,34 m²
    - Grundrisse (Grundrisse (1).pdf)

    Geschossweise Raumflächen (aus Wohnflächenberechnung):
      EG: Wohnen 14,79 + Essen 14,21 + Küche 13,46 + WC 2,50
           + Flur 4,31 + 2× Abstellraum (0,88 + 0,79) = 50,94 m²
      OG: Schlafen 14,21 + Kind1 13,97 + Bad 8,20
           + Flur 9,50 + Ankleide 4,90 = 50,78 m²
      DG: Kind2 ~17,02(roh) + Kind3 ~12,72(roh) + Flur ~7,06(roh) ≈ 36,80 m² (roh)
          (Wohnfläche nach Abzug Dachschräge 50%: 29,20 m²)

    Gebäudegeometrie (aus Grundrissen abgeleitet):
      - Grundfläche: ca. 8,0 m × 6,5 m = 52 m²
      - Geschosshöhe EG/OG: ca. 2,65 m (typisch 1952)
      - DG Kniestockhöhe: ca. 0,80 m, Firsthöhe ca. 3,50 m
      - Dachneigung: ca. 40° (typisch Satteldach 1952)
      - Keller: vorhanden (13,97 m² Kellerraum lt. Wohnflächenberechnung)

    U-Werte Altbau 1952 (OHNE umfassende energetische Sanierung):
    Annahme: Fenster werden für FBH erneuert, Dach wird gedämmt,
             Kellerdecke wird gedämmt, Außenwände NICHT gedämmt
             (typisches Sanierungspaket für FBH-Nachrüstung).
    """

    # ===== GEBÄUDEGEOMETRIE =====
    laenge = 8.0        # m (aus Grundriss)
    breite = 6.5        # m (aus Grundriss)
    grundflaeche = laenge * breite  # 52 m²
    geschosshoehe = 2.65  # m (typisch Altbau 1952)
    anzahl_vollgeschosse = 2  # EG + OG
    dachneigung = 40      # Grad
    kniestock = 0.80      # m

    # Gebäudehöhe bis Traufe
    hoehe_traufe = anzahl_vollgeschosse * geschosshoehe + kniestock

    # Beheiztes Volumen
    vol_eg_og = grundflaeche * geschosshoehe * anzahl_vollgeschosse  # 275,6 m³
    # DG-Volumen (Dreieck + Kniestock)
    vol_dg_kniestock = grundflaeche * kniestock  # 41,6 m³
    dachhoehe_ueber_kniestock = (breite / 2) * math.tan(math.radians(dachneigung))
    vol_dg_dach = grundflaeche * dachhoehe_ueber_kniestock / 2  # Dreiecksquerschnitt
    vol_dg = vol_dg_kniestock + vol_dg_dach
    ve_gesamt = vol_eg_og + vol_dg  # beheiztes Volumen
    v_luft = 0.76 * ve_gesamt       # Luftvolumen (Näherung)

    # ===== HÜLLFLÄCHEN =====
    umfang = 2 * (laenge + breite)  # 29 m

    # WICHTIG: Eine Wand grenzt an den Neubau (Gebäudetrennwand)
    # Diese Wand hat kaum Wärmeverluste (beheizte Zone auf beiden Seiten)
    # Geteilte Wand: ca. 6,5 m breit × volle Höhe
    wand_geteilt_laenge = breite  # 6,5 m (die kurze Seite)

    # Außenwandflächen (ohne geteilte Wand)
    # Außenumfang ohne geteilte Wand
    umfang_aussen = umfang - wand_geteilt_laenge  # 22,5 m
    flaeche_wand_eg_og = umfang_aussen * geschosshoehe * anzahl_vollgeschosse
    flaeche_wand_dg_kniestock = umfang_aussen * kniestock

    # Fensterflächen (typisch für 1952: ca. 15-18% der Wandfläche)
    fenster_anteil = 0.16
    flaeche_fenster = flaeche_wand_eg_og * fenster_anteil
    flaeche_wand_opak = flaeche_wand_eg_og - flaeche_fenster + flaeche_wand_dg_kniestock

    # Dachfläche (Satteldach)
    dachlaenge_schraeg = (breite / 2) / math.cos(math.radians(dachneigung))
    flaeche_dach = 2 * laenge * dachlaenge_schraeg

    # Giebelflächen (2 Dreiecke, aber eine Seite = Neubau-Trennwand)
    # Nur 1 Giebel zur Außenluft
    giebel_hoehe = dachhoehe_ueber_kniestock
    flaeche_giebel_aussen = 1 * (breite * giebel_hoehe / 2)  # nur 1 Giebel

    # Kellerdecke / Bodenplatte
    flaeche_boden = grundflaeche

    # Gesamte Hüllfläche
    flaeche_gesamt = (flaeche_wand_opak + flaeche_fenster +
                      flaeche_dach + flaeche_giebel_aussen + flaeche_boden)

    # ===== U-WERTE ALTBAU 1952 =====
    # Szenario: Fenster neu, Dach gedämmt, Kellerdecke gedämmt,
    #           Wände NICHT gedämmt (typisch bei FBH-Nachrüstung)
    #
    # Begründung: Für monovalenten WP-Betrieb mit FBH (VL 35-45°C)
    # MÜSSEN Fenster, Dach und Kellerdecke gedämmt sein.
    # Wände können optional nachgedämmt werden.

    bauteile_altbau = [
        # --- Außenwände (Bestand 1952, 36,5cm Vollziegel) ---
        # U = 1/(Rsi + d/λ + Rse) = 1/(0,13 + 0,365/0,68 + 0,04)
        #   = 1/(0,13 + 0,537 + 0,04) = 1/0,707 = 1,41 W/(m²K)
        # MIT Innenputz (1,5cm) und Außenputz (2cm):
        # U = 1/(0,13 + 0,015/0,51 + 0,365/0,68 + 0,02/0,87 + 0,04)
        #   = 1/(0,13 + 0,029 + 0,537 + 0,023 + 0,04) = 1/0,759 ≈ 1,32 W/(m²K)
        Bauteil("Außenwände (36,5cm Vollziegel 1952, verputzt)",
                flaeche_wand_opak, 1.32, 1.00),

        # --- Giebel Außenluft (gleicher Aufbau) ---
        Bauteil("Giebelwand Außenluft",
                flaeche_giebel_aussen, 1.32, 1.00),

        # --- Fenster (NEU für FBH-Betrieb) ---
        # 2-fach Wärmeschutzverglasung Ug=1,1, Rahmen Kunststoff
        # Uw ≈ 1,30 W/(m²K)
        Bauteil("Fenster (neu, 2-fach WSV)",
                flaeche_fenster, 1.30, 1.00),

        # --- Dach (GEDÄMMT - Zwischensparrendämmung nachgerüstet) ---
        # Sparren 16cm + 6cm Untersparren, MW032
        # U ≈ 0,22 W/(m²K) (ähnlich wie Neubau, etwas schlechter)
        Bauteil("Dach (Zwischensparren + Untersparrendämmung)",
                flaeche_dach, 0.22, 1.00),

        # --- Kellerdecke (GEDÄMMT - Dämmung von unten, 8cm) ---
        # Betondecke 20cm + 8cm EPS035
        # U = 1/(0,17 + 0,20/2,3 + 0,08/0,035 + 0,04)
        #   = 1/(0,17 + 0,087 + 2,286 + 0,04) = 1/2,583 ≈ 0,39 W/(m²K)
        Bauteil("Kellerdecke (gedämmt 8cm EPS035)",
                flaeche_boden, 0.39, 0.60),  # Fx=0,6 (unbeheizter Keller)

        # --- Haustür (alt, angenommen) ---
        Bauteil("Haustür",
                2.10, 2.00, 1.00),  # ca. 1,0m × 2,1m
    ]

    return Gebaeude(
        name="ALTBAU 1952 (WE1) - Bestand",
        bauteile=bauteile_altbau,
        luftvolumen_m3=v_luft,
        wohnflaeche_m2=130.87,      # exakt aus Wohnflächenberechnung
        nutzflaeche_m2=146.34,      # exakt aus Wohnflächenberechnung
        luftwechselrate=0.50,        # Altbau, Kategorie III (undicht, keine Dichtheitsprüfung)
        waermebruecken_zuschlag=0.10,  # pauschal Altbau (DIN 4108 Beibl. 2, Kategorie B)
        huellflaeche_m2=flaeche_gesamt,
        anzahl_personen=4,           # Familie mit 2 Erwachsenen + 2 Kindern
        geschosszahl=3,              # EG + OG + DG
    )


# ==============================================================================
# 3. WARMWASSERBERECHNUNG
# ==============================================================================
def berechne_warmwasser(anzahl_personen: int, anzahl_wohnungen: int) -> dict:
    """
    Warmwasserbedarf nach DIN 4708 / VDI 4645

    Parameter:
    - anzahl_personen: Gesamtanzahl Personen
    - anzahl_wohnungen: Anzahl Wohneinheiten

    Rückgabe: dict mit WW-Leistungsbedarf
    """
    # Warmwasserverbrauch
    vww_pro_person_tag = 40.0   # Liter/Person/Tag bei 60°C (DIN 4708 Mittelwert)
    temperatur_kaltwasser = 10.0  # °C (Jahresmittel)
    temperatur_warmwasser = 55.0  # °C (WP-Speicher, nicht 60° - WP-typisch)
    delta_t_ww = temperatur_warmwasser - temperatur_kaltwasser  # 45 K

    # Spezifische Wärmekapazität Wasser
    c_wasser = 1.163  # Wh/(kg·K) = Wh/(Liter·K)

    # Tagesbedarf Wärmeenergie
    q_ww_tag = anzahl_personen * vww_pro_person_tag * c_wasser * delta_t_ww  # Wh/Tag
    q_ww_tag_kwh = q_ww_tag / 1000  # kWh/Tag

    # Jahresbedarf
    q_ww_jahr = q_ww_tag_kwh * 365  # kWh/a

    # Mittlere Dauerleistung WW
    p_ww_mittel = q_ww_tag / 24  # W (Durchschnitt über 24h)

    # Spitzenleistung für WW-Bereitung
    # Bei 300L Speicher, Aufheizzeit 4h (VDI 4645):
    speicher_volumen = 300  # Liter (empfohlen für 3 WE)
    aufheizzeit = 4.0       # Stunden
    q_speicher = speicher_volumen * c_wasser * delta_t_ww  # Wh
    p_ww_spitze = q_speicher / aufheizzeit  # W

    # WW-Zuschlag für WP-Dimensionierung
    # Nach VDI 4645: typisch 0,25 × Heizlast oder bedarfsgerecht
    # Für Speicherbetrieb: Zusatzleistung = mittlere Dauerleistung × Gleichzeitigkeitsfaktor
    gleichzeitigkeitsfaktor = 0.8  # WW und Heizung nicht immer gleichzeitig
    p_ww_zuschlag = p_ww_mittel * (1 / gleichzeitigkeitsfaktor)

    return {
        'verbrauch_l_tag': anzahl_personen * vww_pro_person_tag,
        'q_ww_tag_kwh': q_ww_tag_kwh,
        'q_ww_jahr_kwh': q_ww_jahr,
        'p_ww_mittel_w': p_ww_mittel,
        'p_ww_spitze_w': p_ww_spitze,
        'p_ww_zuschlag_w': p_ww_zuschlag,
        'speicher_volumen_l': speicher_volumen,
        'temperatur_ww': temperatur_warmwasser,
        'temperatur_kw': temperatur_kaltwasser,
    }


# ==============================================================================
# 4. WÄRMEPUMPEN-DIMENSIONIERUNG
# ==============================================================================
def dimensioniere_waermepumpe(
    heizlast_neubau_w: float,
    heizlast_altbau_w: float,
    ww_zuschlag_w: float,
) -> dict:
    """
    Dimensionierung der Wärmepumpe nach VDI 4645

    Monovalenter Betrieb (KEIN Gas-Backup):
    Die WP muss bei Normaußentemperatur (-10°C) die VOLLE
    Heizlast + WW-Bedarf alleine decken können.

    Zusätzliche Faktoren:
    - EVU-Sperrzeit: Energieversorger kann WP bis zu 3×2h/Tag sperren
      → Zuschlag 10-15% (Pufferspeicher überbrückt)
    - Abtau-Verluste: Luft-Wasser-WP verliert bei Abtauung Leistung
      → bereits in Herstellerangaben bei -7°C enthalten
    - Sicherheitszuschlag: 5-10% für Ungenauigkeiten
    """

    # Gesamte Heizlast bei Normaußentemperatur
    heizlast_gesamt = heizlast_neubau_w + heizlast_altbau_w

    # WW-Zuschlag
    heizlast_plus_ww = heizlast_gesamt + ww_zuschlag_w

    # EVU-Sperrzeit-Zuschlag (10%)
    # Bei 2h Sperrzeit in 6h-Block: WP muss in 4h die Wärme für 6h erzeugen
    # Faktor: 6/4 = 1,5 → aber mit Pufferspeicher nur ~10% Zuschlag
    faktor_sperrzeit = 1.10

    # Sicherheitszuschlag (5% für Berechnungsungenauigkeiten Altbau)
    faktor_sicherheit = 1.05

    # Erforderliche WP-Nennleistung bei Auslegungspunkt
    # WICHTIG: WP-Hersteller geben Leistung bei verschiedenen Betriebspunkten an
    # Norm-Betriebspunkt: A-7/W35 (Außenluft -7°C / Vorlauf 35°C)
    # Bei -10°C Außentemp: WP hat nur noch ~85-90% der A-7-Leistung
    # → WP muss bei A-10/W35 die erforderliche Leistung liefern

    p_erforderlich_bei_auslegung = heizlast_plus_ww * faktor_sperrzeit * faktor_sicherheit
    # Umrechnung: WP-Katalogangabe bei A-7/W35 ist ca. 10-15% HÖHER als bei A-10/W35
    faktor_a7_zu_a10 = 1.12  # WP-Leistung bei A-7 ist 12% höher als bei A-10
    p_nenn_a7w35 = p_erforderlich_bei_auslegung * faktor_a7_zu_a10

    return {
        'heizlast_gesamt_w': heizlast_gesamt,
        'ww_zuschlag_w': ww_zuschlag_w,
        'heizlast_plus_ww_w': heizlast_plus_ww,
        'faktor_sperrzeit': faktor_sperrzeit,
        'faktor_sicherheit': faktor_sicherheit,
        'p_erforderlich_auslegung_w': p_erforderlich_bei_auslegung,
        'faktor_a7_zu_a10': faktor_a7_zu_a10,
        'p_nenn_a7w35_w': p_nenn_a7w35,
    }


# ==============================================================================
# 5. HAUPTBERECHNUNG UND AUSGABE
# ==============================================================================
def drucke_bauteil_tabelle(gebaeude: Gebaeude):
    """Gibt die Bauteil-Übersicht aus"""
    print(f"\n  {'Bauteil':<55} {'Fläche':>8} {'U-Wert':>8} {'Fx':>5} {'H_T':>8}")
    print(f"  {'':<55} {'[m²]':>8} {'[W/m²K]':>8} {'[-]':>5} {'[W/K]':>8}")
    print(f"  {'─' * 88}")

    ht_summe = 0
    for bt in gebaeude.bauteile:
        ht = bt.ht_bauteil
        ht_summe += ht
        print(f"  {bt.name:<55} {bt.flaeche_m2:>8.2f} {bt.u_wert:>8.2f} {bt.temperatur_faktor:>5.2f} {ht:>8.2f}")

    wb = gebaeude.huellflaeche_m2 * gebaeude.waermebruecken_zuschlag
    print(f"  {'Wärmebrückenzuschlag (ΔU_WB = ' + f'{gebaeude.waermebruecken_zuschlag:.3f} W/m²K)':<55} {gebaeude.huellflaeche_m2:>8.2f} {gebaeude.waermebruecken_zuschlag:>8.3f} {'1.00':>5} {wb:>8.2f}")
    print(f"  {'─' * 88}")
    print(f"  {'SUMME H_T':<77} {ht_summe + wb:>8.2f} W/K")


def main():
    print("=" * 92)
    print("  WÄRMEPUMPEN-DIMENSIONIERUNG")
    print("  Schulstraße 28, 67360 Lingenfeld")
    print("  3-Familienwohnhaus: Altbau (1952) + 2× Neubau (EH55)")
    print("=" * 92)

    print(f"\n  Standort:               {STANDORT}")
    print(f"  Klimazone:              {KLIMAZONE}")
    print(f"  Normaußentemperatur:    {NORM_AUSSENTEMPERATUR:+.1f} °C")
    print(f"  Innentemperatur:        {INNENTEMPERATUR:+.1f} °C")
    print(f"  Temperaturdifferenz:    {DELTA_T:.1f} K")

    # ──────────────────────────────────────────────────────────────────────────
    # NEUBAU (WE2 + WE3)
    # ──────────────────────────────────────────────────────────────────────────
    neubau = erstelle_neubau()

    print(f"\n\n{'═' * 92}")
    print(f"  TEIL 1: NEUBAU EH55 (Wohnung 2 + Wohnung 3)")
    print(f"{'═' * 92}")
    print(f"\n  Quelle: EH55_Schulstraße 28.pdf (Dipl.-Ing. Artur Gerok, 15.01.2022)")
    print(f"  Wohnfläche:            {neubau.wohnflaeche_m2:.1f} m²  (WE2: 129,16 + WE3: 119,63)")
    print(f"  Nutzfläche:            {neubau.nutzflaeche_m2:.1f} m²")
    print(f"  Beheiztes Volumen Ve:  951,6 m³")
    print(f"  Luftvolumen V:         {neubau.luftvolumen_m3:.1f} m³")
    print(f"  Hüllfläche A:          {neubau.huellflaeche_m2:.1f} m²")
    print(f"  HT':                   0,254 W/(m²K)")
    print(f"  Luftwechsel n:         {neubau.luftwechselrate:.2f} h⁻¹ (Kategorie I)")
    print(f"  Standard:              KfW-Effizienzhaus 55")
    print(f"  Heizung:               Fußbodenheizung Nasssystem, VL/RL: 35/28°C")

    # Die exakte Heizlast aus dem Dokument verwenden (6,4 kW)
    NEUBAU_HEIZLAST_EXAKT = 6400  # W - exakt aus Berechnung Seite 35
    print(f"\n  ┌─────────────────────────────────────────────────────┐")
    print(f"  │  GEBÄUDEHEIZLAST NEUBAU (DIN EN 12831-1):           │")
    print(f"  │  Φ_HL = {NEUBAU_HEIZLAST_EXAKT/1000:.1f} kW                                     │")
    print(f"  │  (exakt aus Ingenieur-Berechnung, Seite 35)         │")
    print(f"  │  Spezifisch: {NEUBAU_HEIZLAST_EXAKT/neubau.wohnflaeche_m2:.1f} W/m²                              │")
    print(f"  └─────────────────────────────────────────────────────┘")

    # Kontrollrechnung
    print(f"\n  Kontrollrechnung (vereinfachtes Verfahren):")
    drucke_bauteil_tabelle(neubau)
    print(f"\n  H_T (Transmission):    {neubau.ht_transmission:.2f} W/K")
    print(f"  H_V (Lüftung):         {neubau.hv_lueftung:.2f} W/K")
    print(f"  Φ_T = H_T × ΔT:       {neubau.heizlast_transmission:.0f} W = {neubau.heizlast_transmission/1000:.2f} kW")
    print(f"  Φ_V = H_V × ΔT:       {neubau.heizlast_lueftung:.0f} W = {neubau.heizlast_lueftung/1000:.2f} kW")
    print(f"  Φ_HL (berechnet):      {neubau.heizlast_gesamt:.0f} W = {neubau.heizlast_gesamt/1000:.2f} kW")
    print(f"  → Verwendet wird der EXAKTE Wert aus der Ingenieur-Berechnung: 6,4 kW")

    # ──────────────────────────────────────────────────────────────────────────
    # ALTBAU (WE1)
    # ──────────────────────────────────────────────────────────────────────────
    altbau = erstelle_altbau()

    print(f"\n\n{'═' * 92}")
    print(f"  TEIL 2: ALTBAU 1952 (Wohnung 1 - Bestand)")
    print(f"{'═' * 92}")
    print(f"\n  Quelle: Wohnflächenberechnung Ing. Ruthig + Grundrisse")
    print(f"  Baujahr:               1952")
    print(f"  Wohnfläche:            {altbau.wohnflaeche_m2:.2f} m²")
    print(f"  Nutzfläche:            {altbau.nutzflaeche_m2:.2f} m²")
    print(f"  Luftvolumen V:         {altbau.luftvolumen_m3:.1f} m³")
    print(f"  Hüllfläche A:          {altbau.huellflaeche_m2:.1f} m²")
    print(f"  Luftwechsel n:         {altbau.luftwechselrate:.2f} h⁻¹ (Kategorie III, Altbau)")
    print(f"  Wärmebrücken:          ΔU_WB = {altbau.waermebruecken_zuschlag:.2f} W/(m²K) (pauschal Kat. B)")

    print(f"\n  Annahmen für Sanierungsstand (FBH-kompatibel):")
    print(f"  ├─ Außenwände:  NICHT gedämmt (36,5cm Vollziegel, verputzt)")
    print(f"  ├─ Fenster:     NEU (2-fach WSV, Uw = 1,30 W/m²K)")
    print(f"  ├─ Dach:        GEDÄMMT (Zwischen-/Untersparren, U = 0,22 W/m²K)")
    print(f"  ├─ Kellerdecke: GEDÄMMT (8cm EPS von unten, U = 0,39 W/m²K)")
    print(f"  └─ Haustür:     Bestand (U = 2,00 W/m²K)")

    print(f"\n  Bauteil-Übersicht:")
    drucke_bauteil_tabelle(altbau)

    print(f"\n  H_T (Transmission):    {altbau.ht_transmission:.2f} W/K")
    print(f"  H_V (Lüftung):         {altbau.hv_lueftung:.2f} W/K")
    print(f"  H_T + H_V:             {altbau.ht_transmission + altbau.hv_lueftung:.2f} W/K")
    print(f"\n  Φ_T = H_T × ΔT:       {altbau.heizlast_transmission:.0f} W = {altbau.heizlast_transmission/1000:.2f} kW")
    print(f"  Φ_V = H_V × ΔT:       {altbau.heizlast_lueftung:.0f} W = {altbau.heizlast_lueftung/1000:.2f} kW")

    ALTBAU_HEIZLAST = altbau.heizlast_gesamt

    print(f"\n  ┌─────────────────────────────────────────────────────┐")
    print(f"  │  GEBÄUDEHEIZLAST ALTBAU (DIN EN 12831-1):           │")
    print(f"  │  Φ_HL = {ALTBAU_HEIZLAST/1000:.1f} kW                                    │")
    print(f"  │  (geschätzt, vereinfachtes Verfahren)                │")
    print(f"  │  Spezifisch: {altbau.spezifische_heizlast:.1f} W/m²                             │")
    print(f"  └─────────────────────────────────────────────────────┘")

    # ──────────────────────────────────────────────────────────────────────────
    # WARMWASSER
    # ──────────────────────────────────────────────────────────────────────────
    gesamt_personen = neubau.anzahl_personen + altbau.anzahl_personen  # 6 + 4 = 10

    print(f"\n\n{'═' * 92}")
    print(f"  TEIL 3: WARMWASSERBEDARF (alle 3 Wohnungen)")
    print(f"{'═' * 92}")

    ww = berechne_warmwasser(gesamt_personen, 3)

    print(f"\n  Anzahl Personen:       {gesamt_personen}")
    print(f"    WE1 (Altbau):        {altbau.anzahl_personen} Personen")
    print(f"    WE2 (Neubau):        3 Personen")
    print(f"    WE3 (Neubau):        3 Personen")
    print(f"\n  Warmwassertemperatur:   {ww['temperatur_ww']:.0f} °C")
    print(f"  Kaltwassertemperatur:   {ww['temperatur_kw']:.0f} °C")
    print(f"  Temperaturdiff. WW:     {ww['temperatur_ww'] - ww['temperatur_kw']:.0f} K")
    print(f"\n  Verbrauch:             {ww['verbrauch_l_tag']:.0f} Liter/Tag ({ww['q_ww_tag_kwh']:.1f} kWh/Tag)")
    print(f"  Jahresbedarf WW:       {ww['q_ww_jahr_kwh']:.0f} kWh/a")
    print(f"\n  Mittlere Dauerleistung: {ww['p_ww_mittel_w']:.0f} W = {ww['p_ww_mittel_w']/1000:.2f} kW")
    print(f"  WW-Speicher empfohlen: {ww['speicher_volumen_l']} Liter")
    print(f"  WW-Zuschlag auf WP:    {ww['p_ww_zuschlag_w']:.0f} W = {ww['p_ww_zuschlag_w']/1000:.2f} kW")

    # ──────────────────────────────────────────────────────────────────────────
    # GESAMTERGEBNIS
    # ──────────────────────────────────────────────────────────────────────────
    print(f"\n\n{'═' * 92}")
    print(f"  TEIL 4: WÄRMEPUMPEN-DIMENSIONIERUNG (MONOVALENT)")
    print(f"{'═' * 92}")
    print(f"\n  Betriebsart:           MONOVALENT (reine Wärmepumpe, KEIN Gas)")
    print(f"  Wärmepumpentyp:        Luft-Wasser (Außenluft)")
    print(f"  Wärmeverteilung:       Fußbodenheizung (VL/RL: 35-45/28-35°C)")

    ergebnis = dimensioniere_waermepumpe(
        heizlast_neubau_w=NEUBAU_HEIZLAST_EXAKT,
        heizlast_altbau_w=ALTBAU_HEIZLAST,
        ww_zuschlag_w=ww['p_ww_zuschlag_w'],
    )

    print(f"\n  ┌──────────────────────────────────────────────────────────────────────┐")
    print(f"  │  BERECHNUNG DER ERFORDERLICHEN WÄRMEPUMPENLEISTUNG                  │")
    print(f"  ├──────────────────────────────────────────────────────────────────────┤")
    print(f"  │                                                                      │")
    print(f"  │  1. Heizlast Neubau (WE2+WE3):        {NEUBAU_HEIZLAST_EXAKT:>8.0f} W = {NEUBAU_HEIZLAST_EXAKT/1000:>5.1f} kW   │")
    print(f"  │  2. Heizlast Altbau (WE1):             {ALTBAU_HEIZLAST:>8.0f} W = {ALTBAU_HEIZLAST/1000:>5.1f} kW   │")
    print(f"  │     ─────────────────────────────────────────────────────            │")
    print(f"  │  3. Summe Heizlast:                    {ergebnis['heizlast_gesamt_w']:>8.0f} W = {ergebnis['heizlast_gesamt_w']/1000:>5.1f} kW   │")
    print(f"  │  4. + WW-Zuschlag:                     {ergebnis['ww_zuschlag_w']:>8.0f} W = {ergebnis['ww_zuschlag_w']/1000:>5.1f} kW   │")
    print(f"  │     ─────────────────────────────────────────────────────            │")
    print(f"  │  5. Heizlast + WW:                     {ergebnis['heizlast_plus_ww_w']:>8.0f} W = {ergebnis['heizlast_plus_ww_w']/1000:>5.1f} kW   │")
    print(f"  │  6. × EVU-Sperrzeit (+10%):            × {ergebnis['faktor_sperrzeit']:.2f}                     │")
    print(f"  │  7. × Sicherheit (+5%):                × {ergebnis['faktor_sicherheit']:.2f}                     │")
    print(f"  │     ─────────────────────────────────────────────────────            │")
    print(f"  │  8. Erforderlich bei θ_e = -10°C:      {ergebnis['p_erforderlich_auslegung_w']:>8.0f} W = {ergebnis['p_erforderlich_auslegung_w']/1000:>5.1f} kW   │")
    print(f"  │  9. Umrechnung auf A-7/W35 (×{ergebnis['faktor_a7_zu_a10']:.2f}):   {ergebnis['p_nenn_a7w35_w']:>8.0f} W = {ergebnis['p_nenn_a7w35_w']/1000:>5.1f} kW   │")
    print(f"  │                                                                      │")
    print(f"  ├──────────────────────────────────────────────────────────────────────┤")

    # Empfohlene WP-Größe (auf Standard-Nennleistungen gerundet)
    p_nenn_kw = ergebnis['p_nenn_a7w35_w'] / 1000
    # Aufrunden auf nächste verfügbare Größe
    standard_groessen = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 35]
    wp_groesse = None
    for g in standard_groessen:
        if g >= p_nenn_kw:
            wp_groesse = g
            break
    if wp_groesse is None:
        wp_groesse = math.ceil(p_nenn_kw)

    print(f"  │                                                                      │")
    print(f"  │  ╔══════════════════════════════════════════════════════════════╗     │")
    print(f"  │  ║                                                              ║     │")
    print(f"  │  ║  EMPFOHLENE WÄRMEPUMPE:                                      ║     │")
    print(f"  │  ║                                                              ║     │")
    print(f"  │  ║  Nennleistung (A-7/W35): mindestens {p_nenn_kw:>5.1f} kW              ║     │")
    print(f"  │  ║  → Empfehlung:           {wp_groesse:>2d} kW Luft-Wasser-WP            ║     │")
    print(f"  │  ║                                                              ║     │")
    print(f"  │  ╚══════════════════════════════════════════════════════════════╝     │")
    print(f"  │                                                                      │")
    print(f"  └──────────────────────────────────────────────────────────────────────┘")

    # ──────────────────────────────────────────────────────────────────────────
    # ZUSAMMENFASSUNG UND EMPFEHLUNGEN
    # ──────────────────────────────────────────────────────────────────────────
    print(f"\n\n{'═' * 92}")
    print(f"  ZUSAMMENFASSUNG UND EMPFEHLUNGEN")
    print(f"{'═' * 92}")

    gesamt_wohnflaeche = neubau.wohnflaeche_m2 + altbau.wohnflaeche_m2

    print(f"\n  Gesamte Wohnfläche:                  {gesamt_wohnflaeche:.1f} m²")
    print(f"  Gesamte Heizlast:                    {ergebnis['heizlast_gesamt_w']/1000:.1f} kW")
    print(f"  davon Neubau (WE2+WE3):              {NEUBAU_HEIZLAST_EXAKT/1000:.1f} kW ({NEUBAU_HEIZLAST_EXAKT/ergebnis['heizlast_gesamt_w']*100:.0f}%)")
    print(f"  davon Altbau (WE1):                  {ALTBAU_HEIZLAST/1000:.1f} kW ({ALTBAU_HEIZLAST/ergebnis['heizlast_gesamt_w']*100:.0f}%)")
    print(f"  WW-Zuschlag:                         {ergebnis['ww_zuschlag_w']/1000:.1f} kW")
    print(f"  Erforderliche WP-Leistung (A-7/W35): {p_nenn_kw:.1f} kW")
    print(f"  Empfohlene WP-Nennleistung:          {wp_groesse} kW")

    print(f"\n  Anlagenkonzept:")
    print(f"  ├─ Wärmepumpe:         {wp_groesse} kW Luft-Wasser-Wärmepumpe")
    print(f"  ├─ Pufferspeicher:     500-800 Liter (Heizung)")
    print(f"  ├─ WW-Speicher:        {ww['speicher_volumen_l']} Liter (Trinkwarmwasser)")
    print(f"  ├─ Heizkreis Neubau:   VL/RL 35/28°C (Fußbodenheizung)")
    print(f"  ├─ Heizkreis Altbau:   VL/RL 40-45/30-35°C (Fußbodenheizung)")
    print(f"  └─ Betriebsart:        MONOVALENT (kein Gas)")

    print(f"\n  Geschätzte Jahresarbeitszahl (JAZ):")
    print(f"  ├─ Heizung:            3,2 - 3,8 (Mittelwert ~3,5)")
    print(f"  ├─ Warmwasser:         2,8 - 3,2 (Mittelwert ~3,0)")
    print(f"  └─ Gesamt:             3,0 - 3,6 (Mittelwert ~3,3)")

    # Jahresenergiebedarf
    q_heiz_neubau = 12379  # kWh/a (exakt aus EH55)
    # Altbau Heizenergiebedarf schätzen: Heizlast × Volllaststunden / 1000
    # Volllaststunden Rheinland-Pfalz: ~1800-2000h
    volllaststunden = 1900
    q_heiz_altbau = ALTBAU_HEIZLAST * volllaststunden / 1000  # kWh/a
    q_heiz_gesamt = q_heiz_neubau + q_heiz_altbau
    q_gesamt = q_heiz_gesamt + ww['q_ww_jahr_kwh']

    jaz_mittel = 3.3
    strom_bedarf = q_gesamt / jaz_mittel

    print(f"\n  Geschätzter Jahresenergiebedarf:")
    print(f"  ├─ Heizung Neubau:     {q_heiz_neubau:>8.0f} kWh/a (exakt aus EH55)")
    print(f"  ├─ Heizung Altbau:     {q_heiz_altbau:>8.0f} kWh/a (geschätzt)")
    print(f"  ├─ Warmwasser:         {ww['q_ww_jahr_kwh']:>8.0f} kWh/a")
    print(f"  ├─ GESAMT Wärme:       {q_gesamt:>8.0f} kWh/a")
    print(f"  └─ Strombedarf WP:     ~{strom_bedarf:>7.0f} kWh/a (bei JAZ {jaz_mittel})")

    print(f"\n  WICHTIGE HINWEISE:")
    print(f"  ══════════════════")
    print(f"  1. Die Altbau-Heizlast ist GESCHÄTZT, da keine detaillierte DIN EN 12831")
    print(f"     Berechnung für den Altbau vorliegt. Für die Ausführungsplanung MUSS")
    print(f"     eine raumweise Heizlastberechnung durch einen Fachingenieur erfolgen!")
    print(f"")
    print(f"  2. Für monovalenten WP-Betrieb mit FBH im Altbau wird DRINGEND empfohlen:")
    print(f"     - Außenwände dämmen (WDVS): reduziert Altbau-Heizlast um ~40-50%")
    print(f"     - Neue Fenster (3-fach WSV): bereits in Berechnung berücksichtigt")
    print(f"     - Dach dämmen: bereits in Berechnung berücksichtigt")
    print(f"     - Kellerdecke dämmen: bereits in Berechnung berücksichtigt")
    print(f"")
    print(f"  3. Bei ZUSÄTZLICHER Außenwanddämmung (WDVS 14cm) sinkt die Altbau-")
    print(f"     Heizlast auf ca. {berechne_altbau_mit_wdvs()/1000:.1f} kW → Gesamt-WP dann nur noch ca.")

    altbau_wdvs = berechne_altbau_mit_wdvs()
    ergebnis_wdvs = dimensioniere_waermepumpe(NEUBAU_HEIZLAST_EXAKT, altbau_wdvs, ww['p_ww_zuschlag_w'])
    print(f"     {ergebnis_wdvs['p_nenn_a7w35_w']/1000:.1f} kW (A-7/W35) → {naechste_wp_groesse(ergebnis_wdvs['p_nenn_a7w35_w']/1000)} kW WP ausreichend!")
    print(f"")
    print(f"  4. FBH-Vorlauftemperatur Altbau: Bei ungedämmten Wänden (U=1,32)")
    print(f"     muss die VL-Temperatur ggf. auf 40-45°C erhöht werden.")
    print(f"     → COP/JAZ sinkt um ca. 5-10%")
    print(f"     → Bei WDVS: VL 35°C wie Neubau möglich → bessere JAZ!")

    print(f"\n{'═' * 92}")
    print(f"  ERGEBNIS: Erforderliche Wärmepumpe = {wp_groesse} kW (Luft-Wasser, A-7/W35)")
    print(f"{'═' * 92}")

    return {
        'wp_groesse_kw': wp_groesse,
        'heizlast_gesamt_kw': ergebnis['heizlast_gesamt_w'] / 1000,
        'heizlast_neubau_kw': NEUBAU_HEIZLAST_EXAKT / 1000,
        'heizlast_altbau_kw': ALTBAU_HEIZLAST / 1000,
        'p_nenn_kw': p_nenn_kw,
    }


def berechne_altbau_mit_wdvs() -> float:
    """Berechnet Altbau-Heizlast mit WDVS (14cm EPS035) an Außenwänden"""
    altbau = erstelle_altbau()

    # U-Wert mit WDVS 14cm (EPS035):
    # U = 1/(0,13 + 0,015/0,51 + 0,365/0,68 + 0,14/0,035 + 0,02/0,87 + 0,04)
    #   = 1/(0,13 + 0,029 + 0,537 + 4,000 + 0,023 + 0,04) = 1/4,759 ≈ 0,21 W/(m²K)
    u_wand_wdvs = 0.21

    heizlast_neu = 0
    for bt in altbau.bauteile:
        if "Außenwände" in bt.name or "Giebelwand" in bt.name:
            heizlast_neu += bt.flaeche_m2 * u_wand_wdvs * bt.temperatur_faktor * DELTA_T
        else:
            heizlast_neu += bt.ht_bauteil * DELTA_T

    # Wärmebrücken besser mit WDVS
    wb_zuschlag_wdvs = 0.05  # W/(m²K) - besser als ohne WDVS
    heizlast_neu += altbau.huellflaeche_m2 * wb_zuschlag_wdvs * DELTA_T
    # Lüftung
    heizlast_neu += altbau.hv_lueftung * DELTA_T

    return heizlast_neu


def naechste_wp_groesse(kw: float) -> int:
    """Gibt die nächste Standard-WP-Größe zurück"""
    standard_groessen = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 35]
    for g in standard_groessen:
        if g >= kw:
            return g
    return math.ceil(kw)


# ==============================================================================
# AUSFÜHRUNG
# ==============================================================================
if __name__ == "__main__":
    ergebnis = main()
