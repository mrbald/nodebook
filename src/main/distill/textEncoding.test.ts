import { describe, expect, it } from 'vitest'
import { IMPORT_TEXT_ENCODINGS } from '../../shared/textEncodings'
import { decodeImportText } from './textEncoding'

// The passages were encoded independently with Python's standard codecs.
// Check decoded text because several encoding labels can describe the same bytes.
const legacy = [
  {
    language: "Russian",
    passage:
      "В старой городской библиотеке нашли тетрадь с записями путешественника. Он подробно описал дорогу через северные леса, ночёвку на берегу реки и встречу с людьми, которые помогли ему вернуться домой.",
    files: [
      [
        "windows-1251",
        "wiDx8uDw7ukg4+7w7uTx6u7pIOHo4evo7vLl6uUg7eD46+gg8uXy8ODk/CDxIOfg7+jx/+zoIO/z8uX45fHy4uXt7ejq4C4gzu0g7+7k8O7h7e4g7u/o8eDrIOTu8O7j8yD35fDl5yDx5eLl8O375SDr5fHgLCDt7ve44urzIO3gIOHl8OXj8yDw5eroIOgg4vHy8OX38yDxIOv+5Pzs6Cwg6u7y7vD75SDv7uzu4+voIOXs8yDi5fDt8/L88f8g5O7s7uku"
      ],
      [
        "ibm866",
        "giDh4qDgrqkgo67grqThqq6pIKGooauoruKlqqUgraDoq6gg4qXi4KCk7CDhIKegr6jh76yoIK/j4qXopeHioqWtraiqoC4gjq0gr66k4K6hra4grq+o4aCrIKSu4K6j4yDnpeClpyDhpaKl4K3rpSCrpeGgLCCtrufxoqrjIK2gIKGl4KWj4yDgpaqoIKggouHi4KXn4yDhIKvupOysqCwgqq7iruDrpSCvrqyuo6uoIKWs4yCipeCt4+Ls4e8gpK6srqku"
      ],
      [
        "ibm855",
        "7CDj5aDh1r0grNbh1qbjxta9IKK3otC31uWoxqgg1KD10Lcg5ajl4aCm7SDjIPOg2Lfj3tK3INjn5aj1qOPl66jU1LfGoC4g19Qg2Nam4dai1NYg1ti346DQIKbW4das5yD7qOGo8yDjqOuo4dTxqCDQqOOgLCDU1vuE68bnINSgIKKo4ais5yDhqMa3ILcg6+Pl4aj75yDjINCcpu3Stywgxtbl1uHxqCDY1tLWrNC3IKjS5yDrqOHU5+Xt494gptbS1r0u"
      ],
      [
        "koi8-r",
        "9yDT1MHSz8ogx8/Sz8TTy8/KIMLJwszJz9TFy8UgzsHbzMkg1MXU0sHE2CDTINrB0MnT0c3JINDV1MXbxdPU18XOzsnLwS4g784g0M/E0s/Czs8gz9DJ08HMIMTP0s/H1SDexdLF2iDTxdfF0s7ZxSDMxdPBLCDOz96j18vVIM7BIMLF0sXH1SDSxcvJIMkg19PU0sXe1SDTIMzAxNjNySwgy8/Uz9LZxSDQz83Px8zJIMXN1SDXxdLO1dTY09EgxM/Nz8ou"
      ],
      [
        "iso-8859-5",
        "siDh4tDg3tkg097g3tTh2t7ZINHY0dvY3uLV2tUg3dDo29gg4tXi4NDU7CDhINfQ39jh79zYIN/j4tXo1eHi0tXd3dja0C4gvt0g397U4N7R3d4g3t/Y4dDbINTe4N7T4yDn1eDV1yDh1dLV4N3r1SDb1eHQLCDd3ufx0trjIN3QINHV4NXT4yDg1drYINgg0uHi4NXn4yDhINvu1Ozc2Cwg2t7i3uDr1SDf3tze09vYINXc4yDS1eDd4+Ls4e8g1N7c3tku"
      ],
      [
        "x-mac-cyrillic",
        "giDx8uDw7ukg4+7w7uTx6u7pIOHo4evo7vLl6uUg7eD46+gg8uXy8ODk/CDxIOfg7+jx3+zoIO/z8uX45fHy4uXt7ejq4C4gju0g7+7k8O7h7e4g7u/o8eDrIOTu8O7j8yD35fDl5yDx5eLl8O375SDr5fHgLCDt7vfe4urzIO3gIOHl8OXj8yDw5eroIOgg4vHy8OX38yDxIOv+5Pzs6Cwg6u7y7vD75SDv7uzu4+voIOXs8yDi5fDt8/L88d8g5O7s7uku"
      ],
    ]
  },
  {
    language: "Ukrainian",
    passage:
      "Учора в міській бібліотеці знайшли щоденник мандрівниці. Вона описала поїздку до Києва, зустріч із друзями та старовинні будинки, що збереглися біля Дніпра.",
    files: [
      [
        "koi8-u",
        "9d7P0sEg1yDNptPYy6bKIMKmwsymz9TFw6Yg2s7BytvMySDdz8TFzs7JyyDNwc7E0qbXzsnDpi4g98/OwSDP0MnTwczBINDPp9rEy9UgxM8g68mk18EsINrV09TSpt4gptogxNLV2tHNySDUwSDT1MHSz9fJzs6mIMLVxMnOy8ksIN3PINrCxdLFx8zJ09EgwqbM0SDkzqbQ0sEu"
      ],
    ]
  },
  {
    language: "English",
    passage:
      "The library’s volunteers catalogued a collection of old travel journals. “We found the last volume on a shelf beside the original field maps,” the archivist wrote. Its illustrations show the villages as they looked in the 1920s.",
    files: [
      [
        "windows-1252",
        "VGhlIGxpYnJhcnmScyB2b2x1bnRlZXJzIGNhdGFsb2d1ZWQgYSBjb2xsZWN0aW9uIG9mIG9sZCB0cmF2ZWwgam91cm5hbHMuIJNXZSBmb3VuZCB0aGUgbGFzdCB2b2x1bWUgb24gYSBzaGVsZiBiZXNpZGUgdGhlIG9yaWdpbmFsIGZpZWxkIG1hcHMslCB0aGUgYXJjaGl2aXN0IHdyb3RlLiBJdHMgaWxsdXN0cmF0aW9ucyBzaG93IHRoZSB2aWxsYWdlcyBhcyB0aGV5IGxvb2tlZCBpbiB0aGUgMTkyMHMu"
      ],
    ]
  },
  {
    language: "German",
    passage:
      "Seit dem Frühjahr untersucht das Team die ältesten Bestände der Stadtbücherei. „Die Größe der Sammlung hat uns überrascht“, sagte die Leiterin. Einige Tagebücher erzählen von Reisen über die Alpen und durch das Rheintal.",
    files: [
      [
        "windows-1252",
        "U2VpdCBkZW0gRnL8aGphaHIgdW50ZXJzdWNodCBkYXMgVGVhbSBkaWUg5Gx0ZXN0ZW4gQmVzdORuZGUgZGVyIFN0YWR0YvxjaGVyZWkuIIREaWUgR3L232UgZGVyIFNhbW1sdW5nIGhhdCB1bnMg/GJlcnJhc2NodJMsIHNhZ3RlIGRpZSBMZWl0ZXJpbi4gRWluaWdlIFRhZ2Vi/GNoZXIgZXJ65GhsZW4gdm9uIFJlaXNlbiD8YmVyIGRpZSBBbHBlbiB1bmQgZHVyY2ggZGFzIFJoZWludGFsLg=="
      ],
    ]
  },
  {
    language: "French",
    passage:
      "Depuis l’été dernier, l’équipe d’archéologie étudie les vestiges du château. Grâce aux relevés précis et à plusieurs témoignages, elle a découvert que l’ancienne entrée se trouvait derrière la chapelle.",
    files: [
      [
        "windows-1252",
        "RGVwdWlzIGyS6XTpIGRlcm5pZXIsIGyS6XF1aXBlIGSSYXJjaOlvbG9naWUg6XR1ZGllIGxlcyB2ZXN0aWdlcyBkdSBjaOJ0ZWF1LiBHcuJjZSBhdXggcmVsZXbpcyBwculjaXMgZXQg4CBwbHVzaWV1cnMgdOltb2lnbmFnZXMsIGVsbGUgYSBk6WNvdXZlcnQgcXVlIGySYW5jaWVubmUgZW50cullIHNlIHRyb3V2YWl0IGRlcnJp6HJlIGxhIGNoYXBlbGxlLg=="
      ],
    ]
  },
  {
    language: "French with ligatures",
    passage:
      "L'équipe a découvert les vestiges d'une chapelle au cœur du village. Le coût des travaux est de vingt mille euros (20 000 €). Grâce aux relevés précis, l'ancienne entrée a été reconstruite à l'identique.",
    files: [
      [
        "iso-8859-15",
        "TCfpcXVpcGUgYSBk6WNvdXZlcnQgbGVzIHZlc3RpZ2VzIGQndW5lIGNoYXBlbGxlIGF1IGO9dXIgZHUgdmlsbGFnZS4gTGUgY2/7dCBkZXMgdHJhdmF1eCBlc3QgZGUgdmluZ3QgbWlsbGUgZXVyb3MgKDIwIDAwMCCkKS4gR3LiY2UgYXV4IHJlbGV26XMgcHLpY2lzLCBsJ2FuY2llbm5lIGVudHLpZSBhIOl06SByZWNvbnN0cnVpdGUg4CBsJ2lkZW50aXF1ZS4="
      ],
    ]
  },
  {
    language: "Spanish",
    passage:
      "El equipo de investigación encontró un cuaderno de viajes en la biblioteca municipal. ¿Cómo llegó hasta allí? Una carta recién descubierta menciona la estación de tren, la montaña y los pequeños pueblos de la región.",
    files: [
      [
        "windows-1252",
        "RWwgZXF1aXBvIGRlIGludmVzdGlnYWNp824gZW5jb250cvMgdW4gY3VhZGVybm8gZGUgdmlhamVzIGVuIGxhIGJpYmxpb3RlY2EgbXVuaWNpcGFsLiC/Q/NtbyBsbGVn8yBoYXN0YSBhbGztPyBVbmEgY2FydGEgcmVjaeluIGRlc2N1YmllcnRhIG1lbmNpb25hIGxhIGVzdGFjafNuIGRlIHRyZW4sIGxhIG1vbnRh8WEgeSBsb3MgcGVxdWXxb3MgcHVlYmxvcyBkZSBsYSByZWdp824u"
      ],
    ]
  },
  {
    language: "Italian",
    passage:
      "I ricercatori hanno trovato un vecchio diario nella biblioteca della città. L’autore racconta com’è arrivato in treno fino al paese più lontano della valle e descrive i luoghi dove si è fermato a parlare con gli abitanti.",
    files: [
      [
        "windows-1252",
        "SSByaWNlcmNhdG9yaSBoYW5ubyB0cm92YXRvIHVuIHZlY2NoaW8gZGlhcmlvIG5lbGxhIGJpYmxpb3RlY2EgZGVsbGEgY2l0dOAuIEySYXV0b3JlIHJhY2NvbnRhIGNvbZLoIGFycml2YXRvIGluIHRyZW5vIGZpbm8gYWwgcGFlc2UgcGn5IGxvbnRhbm8gZGVsbGEgdmFsbGUgZSBkZXNjcml2ZSBpIGx1b2doaSBkb3ZlIHNpIOggZmVybWF0byBhIHBhcmxhcmUgY29uIGdsaSBhYml0YW50aS4="
      ],
    ]
  },
  {
    language: "Portuguese",
    passage:
      "Os pesquisadores encontraram um diário antigo na biblioteca da cidade. O autor descreve a sua viagem de trem até as montanhas, as conversas com os moradores e a paisagem da região no começo da estação das chuvas.",
    files: [
      [
        "windows-1252",
        "T3MgcGVzcXVpc2Fkb3JlcyBlbmNvbnRyYXJhbSB1bSBkaeFyaW8gYW50aWdvIG5hIGJpYmxpb3RlY2EgZGEgY2lkYWRlLiBPIGF1dG9yIGRlc2NyZXZlIGEgc3VhIHZpYWdlbSBkZSB0cmVtIGF06SBhcyBtb250YW5oYXMsIGFzIGNvbnZlcnNhcyBjb20gb3MgbW9yYWRvcmVzIGUgYSBwYWlzYWdlbSBkYSByZWdp428gbm8gY29tZedvIGRhIGVzdGHn428gZGFzIGNodXZhcy4="
      ],
    ]
  },
  {
    language: "Polish",
    passage:
      "W zeszłym tygodniu znaleźliśmy w bibliotece zapiski podróżniczki. Opisała górską wędrówkę, długą rozmowę z przyjaciółką i dawną część miasta, którą warto odwiedzić.",
    files: [
      [
        "windows-1250",
        "VyB6ZXN6s3ltIHR5Z29kbml1IHpuYWxln2xpnG15IHcgYmlibGlvdGVjZSB6YXBpc2tpIHBvZHLzv25pY3praS4gT3Bpc2GzYSBn83Jza7kgd+pkcvN3a+osIGSzdWe5IHJvem1vd+ogeiBwcnp5amFjafOza7kgaSBkYXduuSBjeuqc5iBtaWFzdGEsIGt083K5IHdhcnRvIG9kd2llZHpp5i4="
      ],
      [
        "iso-8859-2",
        "VyB6ZXN6s3ltIHR5Z29kbml1IHpuYWxlvGxptm15IHcgYmlibGlvdGVjZSB6YXBpc2tpIHBvZHLzv25pY3praS4gT3Bpc2GzYSBn83Jza7Egd+pkcvN3a+osIGSzdWexIHJvem1vd+ogeiBwcnp5amFjafOza7EgaSBkYXdusSBjeuq25iBtaWFzdGEsIGt083KxIHdhcnRvIG9kd2llZHpp5i4="
      ],
    ]
  },
  {
    language: "Czech",
    passage:
      "V městské knihovně našli starý zápisník horolezce. Podrobně popsal cestu přes zasněžené hory, nepříjemné počasí a setkání s lidmi, kteří mu pomohli vrátit se do údolí.",
    files: [
      [
        "iso-8859-2",
        "ViBt7HN0c2vpIGtuaWhvdm7sIG5huWxpIHN0YXL9IHrhcGlzbu1rIGhvcm9sZXpjZS4gUG9kcm9ibuwgcG9wc2FsIGNlc3R1IHD4ZXMgemFzbuy+ZW7pIGhvcnksIG5lcPjtamVtbukgcG/oYXPtIGEgc2V0a+Fu7SBzIGxpZG1pLCBrdGX47SBtdSBwb21vaGxpIHZy4XRpdCBzZSBkbyD6ZG9s7S4="
      ],
    ]
  },
  {
    language: "Simplified Chinese",
    passage:
      "昨天，研究人员在市立图书馆发现了一本旧日记。作者详细记录了乘坐火车前往西部山区的过程，还介绍了他在那里遇到的村民和他们的日常生活。𠀀",
    files: [
      [
        "gb18030",
        "1/LM7KOs0dC+v8jL1LHU2srQwaLNvMrpud23os/WwcvSu7G+vsnI1bzHoaPX99Xfz+rPuLzHwrzBy7PL1/i78LO1x7DN+c73sr/Jvcf4tcS5/bPMo6y7ub3pydzBy8v71NrEx8Dv0/a1vbXEtOXD8brNy/vDx7XEyNWzo8n6u+6ho5UygjY="
      ],
    ]
  },
  {
    language: "Traditional Chinese",
    passage:
      "昨天，研究人員在市立圖書館找到一本舊日記，記錄了一趟奇妙的旅行。作者搭乘火車前往山區，描述了沿途的風景，也分享了在鄉間遇到的有趣人物。",
    files: [
      [
        "big5",
        "rFGk0aFBrOOoc6RIrfumYqWrpd+5z67RwF2n5KjspEClu8LCpOmwT6FBsE+//aRGpEC966lfp66quq7IpuahQ6dAqsy3Zq28pPWorqtlqbmkc7DPoUG0ea16pEaqdbN+qrqtt7S6oUGkXaTAqMmkRqZitm22oblKqOyquqazveykSKqroUM="
      ],
    ]
  },
  {
    language: "Japanese",
    passage:
      "昨日、市立図書館で古い旅の日記が見つかりました。著者は山間部を列車で訪れ、途中で出会った村人たちの暮らしや、雪が降った日の出来事を書き残していました。",
    files: [
      [
        "shift_jis",
        "jfCT+oFBjnOXp5B9j5GK2YLFjMOCope3gsyT+otMgqqMqYLCgqmC6ILcgrWCvYFCkpiO0oLNjlKK1JWUgvCX8Y7UgsWWS4LqgUGTcpKGgsWPb4nvgsGCvZG6kGyCvYK/gsyV6YLngrWC4oFBkOGCqo1+gsGCvZP6gsyPb5eIjpaC8I+RgquOY4K1gsSCooLcgrWCvYFC"
      ],
      [
        "euc-jp",
        "uvLG/KGiu9TOqb/evfG026THuMWkpM65pM7G/LWtpKy4q6TEpKuk6qTepLekv6Gjw/i81KTPu7O01sn0pPLO87zWpMfLrKTsoaLF08PmpMe90LLxpMOkv8K8v82kv6TBpM7K66TppLek5KGiwOOkrLnfpMOkv8b8pM690M3ou/ak8r3xpK27xKS3pMakpKTepLekv6Gj"
      ],
      [
        "iso-2022-jp",
        "GyRCOnJGfCEiO1ROKT9ePXE0WyRHOEUkJE45JE5GfDUtJCw4KyREJCskaiReJDckPyEjQ3g8VCRPOzM0Vkl0JHJOczxWJEdLLCRsISJFU0NmJEc9UDJxJEMkP0I8P00kPyRBJE5KayRpJDckZCEiQGMkLDlfJEMkP0Z8JE49UE1oO3Ykcj1xJC07RCQ3JEYkJCReJDckPyEjGyhC"
      ],
    ]
  },
  {
    language: "Korean",
    passage:
      "어제 연구원들이 시립 도서관에서 오래된 여행 일기를 발견했습니다. 글쓴이는 기차를 타고 산골 마을을 찾아가 그곳에서 만난 사람들과 그들의 일상생활을 자세히 기록했습니다.",
    files: [
      [
        "euc-kr",
        "vu7BpiC/rLG4v/i16cDMIL3DuLMgtbW8rbD8v6G8rSC/wLehtcggv6nH4CDAz7HiuKYgud+w38ffvcC0z7TZLiCx2760wMy0wiCx4sL3uKYgxbiw7SC76rDxILi2wLvAuyDDo77GsKEgsdew97+hvK0guLizrSC757b3temw+iCx17XpwMcgwM+787v9yLDAuyDA2ry8yPcgseK3z8ffvcC0z7TZLg=="
      ],
    ]
  },
  {
    language: "Arabic",
    passage:
      "عثر الباحثون أمس في المكتبة المركزية على دفتر رحلات قديم. وصف الكاتب رحلته بالقطار إلى الجبال والأشخاص الذين التقى بهم في القرى الصغيرة على طول الطريق.",
    files: [
      [
        "windows-1256",
        "2svRIMfhyMfNy+bkIMPj0yDd7SDH4ePfysjJIMfh49Hf0u3JINrh7CDP3crRINHN4cfKIN7P7eMuIObV3SDH4d/Hysgg0c3hyuUgyMfh3tjH0SDF4ewgx+HMyMfhIObH4cPUzsfVIMfh0O3kIMfhyt7sIMjl4yDd7SDH4d7R7CDH4dXb7dHJINrh7CDY5uEgx+HY0e3eLg=="
      ],
      [
        "iso-8859-6",
        "2cvRIMfkyMfNy+jmIMPl0yDh6iDH5OXjysjJIMfk5dHj0urJINnk6SDP4crRINHN5MfKIOLP6uUuIOjV4SDH5OPHysgg0c3kyucgyMfk4tfH0SDF5Okgx+TMyMfkIOjH5MPUzsfVIMfk0OrmIMfkyuLpIMjn5SDh6iDH5OLR6SDH5NXa6tHJINnk6SDX6OQgx+TX0eriLg=="
      ],
    ]
  },
  {
    language: "Hebrew",
    passage:
      "אתמול גילו החוקרים בספרייה העירונית יומן מסע ישן. המחבר תיאר בפירוט את נסיעתו ברכבת אל ההרים ואת האנשים שפגש בכפרים הקטנים לאורך הדרך.",
    files: [
      [
        "windows-1255",
        "4Pru5ewg4uns5SDk5+X3+OntIOHx9Pjp6eQg5PLp+OXw6fog6eXu7yDu8fIg6fnvLiDk7ufh+CD66eD4IOH06fjl6CDg+iDw8eny+uUg4fjr4fog4Owg5OT46e0g5eD6IOTg8Pnp7SD59OL5IOHr9Pjp7SDk9+jw6e0g7ODl+Oog5OP46i4="
      ],
    ]
  },
  {
    language: "Vietnamese",
    passage:
      "Hôm qua, nhóm nghiên cứu tìm thấy trong thư viện một tập nhật ký cũ. Tác giả kể lại chuyến đi bằng tàu lên vùng núi và cuộc gặp gỡ với các bạn ở bản làng.",
    files: [
      [
        "windows-1258",
        "SPRtIHF1YSwgbmjzbSBuZ2hp6m4gY/3sdSB0acxtIHRo4ux5IHRyb25nIHRo/SB2aerybiBt9PJ0IHTi8nAgbmji8nQga3nsIGN13i4gVOFjIGdpYdIga+rSIGxh8mkgY2h1eersbiDwaSBi48xuZyB04HUgbOpuIHb5bmcgbvppIHbgIGN19PJjIGfj8nAgZ/XeIHb17GkgY+FjIGJh8m4g9dIgYmHSbiBs4G5nLg=="
      ],
    ]
  },
  {
    language: "Thai",
    passage:
      "เมื่อวานนี้นักวิจัยพบสมุดบันทึกการเดินทางเก่าในห้องสมุดของเมือง ผู้เขียนได้เล่าถึงการเดินทางโดยรถไฟไปยังภูเขาและผู้คนที่เขาได้พบในหมู่บ้าน",
    files: [
      [
        "windows-874",
        "4MHX6M3H0rm51em50aHH1KjRwr66ysHYtLrRubfWoaHSw+C01Lm30qfgoejS47nL6c2nysHYtKLNp+DB182nILzZ6eCi1cK55LTp4MXo0rbWp6HSw+C01Lm30qfitMLDtuS/5LvC0afA2eCi0uHF0LzZ6aS5t9Xo4KLS5LTpvrrjucvB2ei66dK5"
      ],
    ]
  },
  {
    language: "Greek",
    passage:
      "Χθες οι ερευνητές βρήκαν στη δημοτική βιβλιοθήκη ένα παλιό ημερολόγιο. Ο συγγραφέας περιγράφει το ταξίδι του στο βουνό και τους ανθρώπους που γνώρισε στα χωριά.",
    files: [
      [
        "iso-8859-7",
        "1+jl8iDv6SDl8eX17ef03fIg4vHe6uHtIPP05yDk5+zv9Onq3iDi6eLr6e/o3urnIN3t4SDw4evp/CDn7OXx7+v84+nvLiDPIPP14+Px4fbd4fIg8OXx6ePx3Pbl6SD07yD04e7f5Okg9O/1IPP07yDi7/Xt/CDq4ekg9O/18iDh7ejx/vDv9fIg8O/1IOPt/vHp8+Ug8/ThIPf58encLg=="
      ],
    ]
  },
  {
    language: "Turkish",
    passage:
      "Araştırmacılar dün şehir kütüphanesinde eski bir gezi günlüğü buldu. Yazar, dağ köylerine yaptığı tren yolculuğunu ve yol boyunca karşılaştığı kişileri ayrıntılı olarak anlatmış.",
    files: [
      [
        "windows-1254",
        "QXJh/nT9cm1hY/1sYXIgZPxuIP5laGlyIGv8dPxwaGFuZXNpbmRlIGVza2kgYmlyIGdlemkgZ/xubPzw/CBidWxkdS4gWWF6YXIsIGRh8CBr9nlsZXJpbmUgeWFwdP3w/SB0cmVuIHlvbGN1bHXwdW51IHZlIHlvbCBib3l1bmNhIGthcv79bGH+dP3w/SBraf5pbGVyaSBheXL9bnT9bP0gb2xhcmFrIGFubGF0bf3+Lg=="
      ],
    ]
  }
] as const

const legacyCases = legacy.flatMap(({ language, passage, files }) =>
  files.map(([encoding, base64]) => ({ language, encoding, passage, base64 }))
)

function utf16(text: string, order: 'le' | 'be', bom = false): Buffer {
  const bytes = Buffer.from(bom ? '\uFEFF' + text : text, 'utf16le')
  return order === 'le' ? bytes : bytes.swap16()
}

describe('decodeImportText', () => {
  it.each(legacyCases)('recovers $language encoded as $encoding', ({ encoding, passage, base64 }) => {
    const bytes = Buffer.from(base64, 'base64')
    expect(decodeImportText(bytes)).toMatchObject({ text: passage, source: 'detected' })
    expect(decodeImportText(bytes, { encoding })).toEqual({
      text: passage,
      encoding,
      source: 'chosen'
    })
  })

  it.each(['', 'plain ASCII\n', '旅の日記 — Дневник — café 😀'])('preserves UTF-8 text %j', (text) => {
    expect(decodeImportText(Buffer.from(text))).toEqual({ text, encoding: 'utf-8', source: 'utf8' })
  })

  it('gives a UTF-8 BOM precedence over a legacy declaration and removes it', () => {
    const text = '<meta charset="windows-1251">русский текст'
    expect(decodeImportText(Buffer.from('\uFEFF' + text), { html: true })).toEqual({
      text,
      encoding: 'utf-8',
      source: 'bom'
    })
  })

  it.each(['le', 'be'] as const)('handles both marked and unmarked UTF-16%s', (order) => {
    // The Cyrillic К has low byte 0x1a. In big-endian input that byte
    // appears at the same position as a DOS EOF marker.
    const text = 'An old travel diary. К'
    for (const bom of [true, false]) {
      expect(decodeImportText(utf16(text, order, bom))).toEqual({
        text,
        encoding: 'utf-16' + order,
        source: bom ? 'bom' : 'detected'
      })
    }
  })

  it.each(['le', 'be'] as const)('recognizes a short unmarked UTF-16%s title', (order) => {
    expect(decodeImportText(utf16('Hi', order))).toEqual({
      text: 'Hi',
      encoding: 'utf-16' + order,
      source: 'detected'
    })
  })

  it('reads BOM-less Japanese UTF-16 when the user selects the byte order', () => {
    const text = '市立図書館で古い旅の日記が見つかりました。'
    expect(decodeImportText(utf16(text, 'be'), { encoding: 'utf-16be' })).toEqual({
      text,
      encoding: 'utf-16be',
      source: 'chosen'
    })
  })

  it('reports malformed UTF-8 with a BOM, and unsupported UTF-32', () => {
    expect(() => decodeImportText(Uint8Array.of(0xef, 0xbb, 0xbf, 0xc0, 0xaf))).toThrow(/byte-order mark/)
    expect(() => decodeImportText(Uint8Array.of(0xff, 0xfe, 0x00, 0x00))).toThrow(/UTF-8/)
  })

  it('respects an HTML charset and a quoted legacy content-type declaration', () => {
    for (const meta of [
      '<meta charset="windows-1252">',
      '<meta content="text/html; charset=\'windows-1252\'" HTTP-EQUIV=Content-Type>'
    ]) {
      const text = meta + '<p>Café à Paris</p>'
      expect(decodeImportText(Buffer.from(text, 'latin1'), { html: true })).toEqual({
        text,
        encoding: 'windows-1252',
        source: 'declared'
      })
    }
  })

  it('decodes ISO-8859-16 text chosen by the reader or declared in HTML or XML', () => {
    const text = 'Ștefan și Țurcanu au plătit 25 € pentru „cărți”.'
    const bytes = Buffer.from(
      'aa746566616e20ba6920de757263616e7520617520706ce374697420323520a42070656e74727520a563e372fe69b52e',
      'hex'
    )
    const encoding = 'iso-8859-16'
    expect(decodeImportText(bytes, { encoding })).toEqual({ text, encoding, source: 'chosen' })
    for (const [header, options] of [
      ['<meta charset="ISO-8859-16">', { html: true }],
      ['<?xml version="1.0" encoding="ISO-8859-16"?>', { xml: true }]
    ] as const) {
      expect(decodeImportText(Buffer.concat([Buffer.from(header), bytes]), options)).toEqual({
        text: header + text,
        encoding,
        source: 'declared'
      })
    }
  })

  it('ignores bogus declarations in comments, raw text, and other attribute values', () => {
    const text = [
      '<!-- <meta charset="windows-1251"> -->',
      '<script>const demo = \'<meta charset="windows-1251">\'</script>',
      '<link data-demo=\'<meta charset="windows-1251">\'>',
      '<meta content="text/html; charset=windows-1251">',
      '<meta charset="missing-decoder">',
      '<meta charset=windows-1252>',
      '<p>Café à Paris</p>'
    ].join('\n')
    expect(decodeImportText(Buffer.from(text, 'latin1'), { html: true })).toMatchObject({
      text,
      encoding: 'windows-1252',
      source: 'declared'
    })
  })

  it('recognizes an XML declaration in markup and allows an explicit override', () => {
    const text = '<?xml version="1.0" encoding="windows-1251"?><title>Café</title>'
    const bytes = Buffer.from(text, 'latin1')
    expect(decodeImportText(bytes, { xml: true })).toMatchObject({
      text: text.replace('Café', 'Cafй'),
      encoding: 'windows-1251',
      source: 'declared'
    })
    expect(decodeImportText(bytes, { xml: true, encoding: 'latin1' })).toMatchObject({
      text,
      encoding: 'windows-1252',
      source: 'chosen'
    })
  })

  it('marks a guess when bytes contradict a declared encoding', () => {
    const text = '<meta charset=utf-8><p>Café à Paris</p>'
    expect(decodeImportText(Buffer.from(text, 'latin1'), { html: true })).toMatchObject({
      source: 'detected',
      uncertain: true
    })
  })

  it('flags a genuinely short ambiguous legacy sample and applies the user choice strictly', () => {
    const bytes = Uint8Array.of(0x43, 0x61, 0x66, 0xe9)
    expect(decodeImportText(bytes)).toMatchObject({ source: 'detected', uncertain: true })
    expect(decodeImportText(bytes, { encoding: 'windows-1252' })).toEqual({
      text: 'Café',
      encoding: 'windows-1252',
      source: 'chosen'
    })
    expect(() => decodeImportText(bytes, { encoding: 'utf-8' })).toThrow(/Cannot read/)
    expect(() => decodeImportText(bytes, { encoding: 'bogus' })).toThrow(/Unsupported text encoding/)
  })

  it('looks beyond a long ASCII prefix for evidence of a legacy encoding', () => {
    const fixture = legacyCases.find((item) => item.encoding === 'ibm866')!
    const prefix = 'Front matter.\n'.repeat(16_000)
    const bytes = Buffer.concat([Buffer.from(prefix), Buffer.from(fixture.base64, 'base64')])
    expect(decodeImportText(bytes)).toMatchObject({ text: prefix + fixture.passage, encoding: 'ibm866' })
  })

  it('strips a trailing DOS EOF marker even from short DOS files', () => {
    const bytes = Uint8Array.of(0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2, 0x1a)
    expect(decodeImportText(bytes)).toMatchObject({ text: 'Привет', encoding: 'ibm866' })
    expect(decodeImportText(bytes, { encoding: 'cp866' })).toMatchObject({ text: 'Привет', encoding: 'ibm866' })
    expect(decodeImportText(Buffer.from('a plain DOS file\x1a')).text).toBe('a plain DOS file')
    expect(() => decodeImportText(Buffer.from('interior\x1a marker'))).toThrow(/readable text/)
  })

  it('rejects binary signatures and embedded binary controls', () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff)
    expect(() => decodeImportText(jpeg)).toThrow(/readable text/)
    expect(() => decodeImportText(jpeg, { encoding: 'windows-1252' })).toThrow(/readable text/)
    expect(() => decodeImportText(Uint8Array.of(0x00, 0x01, 0x02, 0x03))).toThrow(/readable text/)
  })

  it('calls out widespread previous replacement damage and preserves an occasional literal �', () => {
    const corrupted = Buffer.from('������� travel diary �')
    expect(() => decodeImportText(corrupted)).toThrow(/Import the original file or a fresh export/)
    expect(() => decodeImportText(corrupted, { encoding: 'windows-1251' })).toThrow(/replacement characters/)
    expect(() => decodeImportText(utf16('������� travel diary', 'le', true))).toThrow(/replacement characters/)
    expect(decodeImportText(Buffer.from('A literal � can appear in technical text.')).text)
      .toBe('A literal � can appear in technical text.')
  })

  it('exposes only working explicit encoding choices', () => {
    for (const { id } of IMPORT_TEXT_ENCODINGS) {
      const bytes = id.startsWith('utf-16') ? utf16('Text', id.endsWith('le') ? 'le' : 'be') : Buffer.from('Text')
      expect(decodeImportText(bytes, { encoding: id })).toEqual({ text: 'Text', encoding: id, source: 'chosen' })
    }
  })
})


it('flags a stale declaration that would garble valid UTF-8 and skips inert template declarations', () => {
  const header = '<meta charset="windows-1252">'
  const html = Buffer.from(header + '<p>café déjà français</p>')
  expect(decodeImportText(html, { html: true })).toMatchObject({ source: 'declared', uncertain: true })
  expect(decodeImportText(html, { html: true, encoding: 'utf-8' }).text).toContain('café déjà français')
  expect(decodeImportText(Buffer.from(header + '<p>plain ASCII</p>'), { html: true }).uncertain).toBeFalsy()
  const template = '<template>' + header + '</template><meta charset="utf-8">'
  expect(decodeImportText(Buffer.from(template + 'déjà'), { html: true }).text).toContain('déjà')
})
