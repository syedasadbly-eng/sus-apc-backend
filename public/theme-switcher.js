(function(){
  var KEY='sus-dashboard-skin', SKIN='pearl-obsidian';
  var root=document.documentElement;
  var link=document.createElement('link');
  link.rel='stylesheet';link.href='./theme-pearl-obsidian.css';
  document.head.appendChild(link);
  var fontLink=document.createElement('link');
  fontLink.rel='stylesheet';fontLink.href='https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  document.head.appendChild(fontLink);
  var saved=null;
  try{saved=localStorage.getItem(KEY)}catch(e){}
  var original=null;
  function refreshCharts(){
    if(!window.Chart)return;
    if(!original)original={color:Chart.defaults.color,border:Chart.defaults.borderColor};
    if(root.getAttribute('data-skin')===SKIN){Chart.defaults.color='#c4cedc';Chart.defaults.borderColor='#202b3b'}
    else{Chart.defaults.color=original.color;Chart.defaults.borderColor=original.border}
    try{var inst=Chart.instances;Object.keys(inst).forEach(function(k){var c=inst[k];if(!c)return;if(c.options&&c.options.scales){Object.keys(c.options.scales).forEach(function(s){var sc=c.options.scales[s];if(sc&&sc.ticks)sc.ticks.color=Chart.defaults.color;if(sc&&sc.grid)sc.grid.color=Chart.defaults.borderColor})}c.update('none')})}catch(e){}
  }
  function apply(v){
    if(v===SKIN)root.setAttribute('data-skin',SKIN);else root.removeAttribute('data-skin');
    try{localStorage.setItem(KEY,v)}catch(e){}
    refreshCharts();
    window.dispatchEvent(new Event('resize'));
  }
  function mount(){
    var host=document.querySelector('.header-right');
    if(!host||document.getElementById('susThemeSelect'))return;
    var wrap=document.createElement('div');wrap.className='theme-select-wrap';
    var sel=document.createElement('select');sel.id='susThemeSelect';sel.setAttribute('aria-label','Dashboard theme');
    [['original','Original dark'],[SKIN,'Pearl & Obsidian']].forEach(function(o){var op=document.createElement('option');op.value=o[0];op.textContent=o[1];sel.appendChild(op)});
    sel.value=saved===SKIN?SKIN:'original';
    sel.addEventListener('change',function(){apply(sel.value)});
    wrap.appendChild(sel);host.insertBefore(wrap,host.firstChild);
  }
  if(saved===SKIN)root.setAttribute('data-skin',SKIN);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){mount();refreshCharts()});else{mount();refreshCharts()}
  window.addEventListener('load',refreshCharts);
})();
